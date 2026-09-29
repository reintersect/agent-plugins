import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FileSystem, Path } from "@effect/platform";
import { Array, Clock, Effect, Option, Schedule, Schema } from "effect";
import { Backend } from "#backend";
import { renderEvidence } from "#capture";
import { FlushWorkerBin, MAX_MESSAGE_CHARS } from "#config";
import { BackendCallError } from "#errors";
import type { CaptureRecord, Handoff, IngestEvent } from "#schema";
import { AgentStore, sessionKey } from "#store";

export const STALE_RUNNING_MS = 5 * 60 * 1_000;

const PENDING_LAUNCH_LIMIT = 5;

const INGEST_BATCH_LIMIT = 200;

const splitText = (text: string) =>
  globalThis.Array.from({ length: Math.ceil(text.length / MAX_MESSAGE_CHARS) }, (_, index) =>
    text.slice(index * MAX_MESSAGE_CHARS, (index + 1) * MAX_MESSAGE_CHARS),
  );

export const buildEvents = (
  records: ReadonlyArray<CaptureRecord>,
  fromIndex: number,
  nextSeq: number,
): ReadonlyArray<IngestEvent> => {
  const slice = records.slice(fromIndex);

  if (!Array.isNonEmptyReadonlyArray(slice)) return [];

  const evidence = renderEvidence(slice);
  const observedAt = Array.lastNonEmpty(slice).observedAt;
  const drafts = [
    ...slice.flatMap((record) =>
      record.kind === "person" || record.kind === "agent"
        ? [{ role: record.kind, text: record.text, observedAt: record.observedAt }]
        : [],
    ),
    ...(evidence ? [{ role: "evidence" as const, text: evidence, observedAt }] : []),
  ];

  return drafts
    .flatMap((draft) => splitText(draft.text).map((text) => ({ ...draft, text })))
    .map((draft, index) => ({ ...draft, seq: nextSeq + index }));
};

export const launchHandoff = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bin = yield* FlushWorkerBin;

    const running = path.endsWith(".running") ? path : path.replace(/\.json$/, ".running");
    yield* fs.rename(path, running);
    const now = new Date(yield* Clock.currentTimeMillis);
    yield* fs.utimes(running, now, now);
    yield* Effect.sync(() => {
      const child = spawn(
        process.execPath,
        [Option.getOrElse(bin, () => fileURLToPath(import.meta.url)), "flush", running],
        { detached: true, stdio: "ignore" },
      );
      child.on("error", () => undefined);
      child.unref();
    });
  });

export const scheduleFlush = (handoff: Handoff) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;
    const path = yield* Path.Path;

    if (yield* store.isPaused) return;

    const key = sessionKey(handoff.host, handoff.sessionId);
    const file = yield* store.withLock(
      key,
      Effect.gen(function* () {
        const pending = yield* store.listPending;
        const state = yield* store.readState(handoff.host, handoff.sessionId);

        if (
          Option.isNone(state) ||
          state.value.scopeMismatch ||
          state.value.scopeChanged ||
          state.value.scopeKey === undefined
        )
          return Option.none<string>();
        if (pending.some((name) => name.startsWith(`${key}__`))) return Option.none<string>();

        const now = yield* Clock.currentTimeMillis;
        if (
          handoff.reason === "background-recall" &&
          state.value.lastFlushAt !== undefined &&
          now - state.value.lastFlushAt < 60_000
        )
          return Option.none<string>();

        const records = yield* store.readRecords(handoff.host, handoff.sessionId);
        const events = buildEvents(records, state.value.flushedRecords, state.value.nextSeq);

        if (events.length === 0) return Option.none<string>();

        const file = path.join(store.pendingDir, `${key}__${handoff.reason}__${randomUUID()}.json`);
        yield* store.writeHandoff(file, {
          ...handoff,
          snapshot: {
            events,
            throughRecord: records.length,
            nextSeq: state.value.nextSeq + events.length,
            repository: state.value.repository,
            branch: state.value.branch,
            scopeKey: state.value.scopeKey,
            apiUrl: state.value.apiUrl,
            credentialKey: state.value.credentialKey,
          },
        });
        yield* store.writeState({ ...state.value, lastFlushAt: now });
        return Option.some(file);
      }),
    );

    yield* Effect.forEach(Option.toArray(file), launchHandoff, { discard: true });
  });

const ageOf = (fs: FileSystem.FileSystem, file: string, now: number) =>
  fs
    .stat(file)
    .pipe(Effect.map((info) => now - Option.getOrElse(info.mtime, () => new Date(0)).getTime()));

export const recoverPending = Effect.gen(function* () {
  const store = yield* AgentStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (yield* store.isPaused) return 0;

  const now = yield* Clock.currentTimeMillis;
  const names = yield* store.listPending;
  const fileOf = (name: string) => path.join(store.pendingDir, name);

  yield* Effect.forEach(
    names.filter((name) => name.endsWith(".running")),
    (name) =>
      ageOf(fs, fileOf(name), now).pipe(
        Effect.flatMap((age) =>
          fs
            .rename(fileOf(name), fileOf(name.replace(/\.running$/, ".json")))
            .pipe(Effect.when(() => age > STALE_RUNNING_MS)),
        ),
        Effect.ignore,
      ),
    { discard: true },
  );

  const fresh = (yield* store.listPending).filter((name) => name.endsWith(".json"));
  yield* Effect.forEach(
    fresh.slice(0, PENDING_LAUNCH_LIMIT),
    (name) => launchHandoff(fileOf(name)).pipe(Effect.ignore),
    { discard: true },
  );
  return fresh.length;
});

const ingest = (handoff: Handoff & { snapshot: NonNullable<Handoff["snapshot"]> }) =>
  Effect.gen(function* () {
    const backend = yield* Backend;
    const store = yield* AgentStore;

    const snapshot = handoff.snapshot;
    if (snapshot.scopeKey === undefined || snapshot.apiUrl !== (yield* backend.apiUrl)) {
      return yield* new BackendCallError({
        tool: "IngestCodingSession",
        message: "Captured events belong to another sign-in",
        category: "scope_changed",
      });
    }
    yield* Effect.forEach(
      Array.chunksOf(snapshot.events, INGEST_BATCH_LIMIT),
      (events) =>
        Effect.gen(function* () {
          if ((yield* store.isPaused) || snapshot.apiUrl !== (yield* backend.apiUrl)) {
            return yield* new BackendCallError({
              tool: "IngestCodingSession",
              message: "Capture is paused or its API changed",
            });
          }
          yield* backend.callTool(
            "IngestCodingSession",
            {
              host: handoff.host,
              hostSessionId: handoff.sessionId,
              repository: snapshot.repository,
              branch: snapshot.branch,
              scopeKey: snapshot.scopeKey,
              events,
            },
            "Shipping a captured local coding session to Reintersect so it can extract memories",
            Schema.Unknown,
          );
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.retry({
            while: (error) =>
              error._tag === "TimeoutException" ||
              (error._tag === "BackendCallError" && error.retryable === true),
            schedule: Schedule.exponential("1 second").pipe(
              Schedule.intersect(Schedule.recurs(2)),
              Schedule.jittered,
            ),
          }),
        ),
      { discard: true },
    );
  });

export const runFlush = (path: string) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;
    const fs = yield* FileSystem.FileSystem;

    if (yield* store.isPaused) {
      yield* fs.rename(path, path.replace(/\.running$/, ".json")).pipe(Effect.ignore);
      return;
    }
    const pending = yield* store.readHandoff(path);
    if (Option.isNone(pending)) return;
    const handoff = pending.value;
    const key = sessionKey(handoff.host, handoff.sessionId);
    const completed = yield* store.withLock(
      `upload-${key}`,
      Effect.gen(function* () {
        const snapshot = yield* store.withLock(
          key,
          Effect.gen(function* () {
            const state = yield* store.readState(handoff.host, handoff.sessionId);
            if (Option.isNone(state)) return Option.none<NonNullable<Handoff["snapshot"]>>();
            if (handoff.snapshot !== undefined) return Option.some(handoff.snapshot);

            const records = yield* store.readRecords(handoff.host, handoff.sessionId);
            const events = buildEvents(records, state.value.flushedRecords, state.value.nextSeq);
            const snapshot = {
              events,
              throughRecord: records.length,
              nextSeq: state.value.nextSeq + events.length,
              repository: state.value.repository,
              branch: state.value.branch,
              scopeKey: state.value.scopeKey,
              apiUrl: state.value.apiUrl,
              credentialKey: state.value.credentialKey,
            };
            yield* store.writeHandoff(path, { ...handoff, snapshot });
            return Option.some(snapshot);
          }),
        );
        if (Option.isNone(snapshot)) return false;

        yield* ingest({ ...handoff, snapshot: snapshot.value });
        yield* store.withLock(
          key,
          Effect.gen(function* () {
            const current = yield* store.readState(handoff.host, handoff.sessionId);
            if (Option.isNone(current)) return;

            const now = yield* Clock.currentTimeMillis;
            const remaining = (yield* store.readRecords(handoff.host, handoff.sessionId)).slice(
              snapshot.value.throughRecord,
            );
            yield* store.writeState({
              ...current.value,
              flushedRecords: Math.max(current.value.flushedRecords, snapshot.value.throughRecord),
              nextSeq: Math.max(current.value.nextSeq, snapshot.value.nextSeq),
              lastUploadAt: now,
              pendingSince: remaining.length > 0 ? current.value.pendingSince : undefined,
              queueWarned: false,
            });
            yield* fs.remove(path);
          }),
        );
        return true;
      }),
    );

    yield* scheduleFlush({
      host: handoff.host,
      sessionId: handoff.sessionId,
      reason: "continued",
    }).pipe(Effect.when(() => completed));
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        const store = yield* AgentStore;
        const fs = yield* FileSystem.FileSystem;

        yield* store.logError("flush", error).pipe(Effect.ignore);
        yield* fs.rename(path, path.replace(/\.running$/, ".json")).pipe(Effect.ignore);
      }),
    ),
  );

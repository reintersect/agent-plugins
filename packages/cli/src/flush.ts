import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FileSystem, Path } from "@effect/platform";
import { Array, Clock, Effect, Option, Schema } from "effect";
import { Backend } from "#backend";
import { renderEvidence } from "#capture";
import { FlushWorkerBin, MAX_MESSAGE_CHARS } from "#config";
import type { CaptureRecord, Handoff, IngestEvent, SessionState } from "#schema";
import { AgentStore, sessionKey } from "#store";

const PENDING_EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000;

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

    yield* fs.rename(path, running).pipe(Effect.ignore);
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

    const name = `${sessionKey(handoff.host, handoff.sessionId)}__${handoff.reason}__${randomUUID().slice(0, 8)}.json`;
    const file = path.join(store.pendingDir, name);

    yield* store.writeHandoff(file, handoff);
    yield* launchHandoff(file);
  });

const ageOf = (fs: FileSystem.FileSystem, file: string, now: number) =>
  fs
    .stat(file)
    .pipe(Effect.map((info) => now - Option.getOrElse(info.mtime, () => new Date(0)).getTime()));

export const recoverPending = Effect.gen(function* () {
  const store = yield* AgentStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const now = yield* Clock.currentTimeMillis;
  const fileOf = (name: string) => path.join(store.pendingDir, name);
  const names = yield* store.listPending;

  yield* Effect.forEach(
    names.filter((name) => name.endsWith(".running")),
    (name) =>
      ageOf(fs, fileOf(name), now).pipe(
        Effect.flatMap((age) =>
          Effect.when(
            fs.rename(fileOf(name), fileOf(name.replace(/\.running$/, ".json"))),
            () => age > STALE_RUNNING_MS,
          ),
        ),
        Effect.ignore,
      ),
    { discard: true },
  );

  const fresh = yield* store.listPending;
  const kept = yield* Effect.forEach(
    fresh.filter((name) => name.endsWith(".json")),
    (name) =>
      ageOf(fs, fileOf(name), now).pipe(
        Effect.flatMap((age) =>
          age > PENDING_EXPIRY_MS
            ? fs.remove(fileOf(name)).pipe(Effect.as(Option.none<string>()))
            : Effect.succeed(Option.some(name)),
        ),
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
  );
  const launchable = Array.getSomes(kept);

  yield* Effect.forEach(
    launchable.slice(0, PENDING_LAUNCH_LIMIT),
    (name) => launchHandoff(fileOf(name)).pipe(Effect.ignore),
    { discard: true },
  );

  return launchable.length;
});

const ingest = (state: SessionState, events: ReadonlyArray<IngestEvent>) =>
  Effect.gen(function* () {
    const backend = yield* Backend;

    yield* Effect.forEach(
      Array.chunksOf(events, INGEST_BATCH_LIMIT),
      (batch) =>
        backend.callTool(
          "IngestCodingSession",
          {
            host: state.host,
            hostSessionId: state.sessionId,
            ...(state.repository === undefined ? {} : { repository: state.repository }),
            ...(state.branch === undefined ? {} : { branch: state.branch }),
            events: batch,
          },
          "Shipping a captured local coding session to Reintersect so it can extract memories",
          Schema.Unknown,
        ),
      { discard: true },
    );
  });

export const runFlush = (path: string) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;
    const fs = yield* FileSystem.FileSystem;

    const handoff = yield* store.readHandoff(path);

    if (Option.isNone(handoff)) return;

    const state = yield* store.readState(handoff.value.host, handoff.value.sessionId);

    if (Option.isNone(state)) {
      yield* fs.remove(path).pipe(Effect.ignore);
      return;
    }

    const records = yield* store.readRecords(handoff.value.host, handoff.value.sessionId);
    const events = buildEvents(records, state.value.flushedRecords, state.value.nextSeq);

    yield* Effect.when(ingest(state.value, events), () => events.length > 0);
    yield* store.writeState({
      ...state.value,
      flushedRecords: records.length,
      nextSeq: state.value.nextSeq + events.length,
      exchanges: 0,
      pendingChars: 0,
    });
    yield* fs.remove(path).pipe(Effect.ignore);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        const store = yield* AgentStore;
        const fs = yield* FileSystem.FileSystem;

        yield* store.logError("flush", error);
        yield* fs.rename(path, path.replace(/\.running$/, ".json")).pipe(Effect.ignore);
      }),
    ),
  );

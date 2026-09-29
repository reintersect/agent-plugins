import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { FileSystem, Path } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Array, DateTime, Effect, Option, Schema } from "effect";
import { AgentHome } from "#config";
import { withFileLock } from "#fileLock";
import { EMPTY_RECALL_STATE, RecallState } from "#recallSchema";
import { AuthFile, CaptureRecord, Handoff, type Host, SessionState } from "#schema";

export const sessionKey = (host: Host, sessionId: string) =>
  `${host}-${sessionId}`.replace(/[^A-Za-z0-9._-]/g, "_");

const OWNER_ONLY = 0o600;

export class AgentStore extends Effect.Service<AgentStore>()("AgentStore", {
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configuredHome = yield* AgentHome;

    const home = Option.getOrElse(configuredHome, () =>
      path.join(homedir(), ".reintersect", "agent"),
    );

    const sessionsDir = path.join(home, "sessions");
    const locksDir = path.join(home, "locks");
    const recallDir = path.join(home, "recall");
    const pendingDir = path.join(home, "pending");
    const pausedPath = path.join(home, "paused");
    const authPath = path.join(home, "auth.json");
    const errorLogPath = path.join(home, "errors.log");
    const statePath = (host: Host, sessionId: string) =>
      path.join(sessionsDir, `${sessionKey(host, sessionId)}.state.json`);
    const logPath = (host: Host, sessionId: string) =>
      path.join(sessionsDir, `${sessionKey(host, sessionId)}.jsonl`);

    const ensureDir = (directory: string) => fs.makeDirectory(directory, { recursive: true });
    const readJson = <A, I>(schema: Schema.Schema<A, I>, file: string) =>
      fs.readFileString(file).pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(schema))),
        Effect.map(Option.some),
        Effect.catchTag("SystemError", (error) =>
          error.reason === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
        ),
      );
    const writeJson = <A, I>(
      schema: Schema.Schema<A, I>,
      file: string,
      value: A,
      options?: FileSystem.WriteFileStringOptions,
    ) =>
      Schema.encode(Schema.parseJson(schema, { space: 2 }))(value).pipe(
        Effect.flatMap((text) =>
          Effect.gen(function* () {
            const temporary = `${file}.${randomUUID()}.tmp`;

            yield* ensureDir(path.dirname(file));
            yield* fs.writeFileString(temporary, `${text}\n`, { mode: OWNER_ONLY, ...options });
            yield* fs
              .rename(temporary, file)
              .pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)));
          }),
        ),
      );
    const appendLine = (file: string, line: string) =>
      ensureDir(path.dirname(file)).pipe(
        Effect.zipRight(fs.writeFileString(file, `${line}\n`, { flag: "a", mode: OWNER_ONLY })),
      );
    const withLock = <A, E, R>(key: string, operation: Effect.Effect<A, E, R>) =>
      ensureDir(locksDir).pipe(
        Effect.zipRight(
          withFileLock(path.join(locksDir, key.replace(/[^A-Za-z0-9._-]/g, "_")), operation).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
          ),
        ),
      );
    const recallPath = (host: Host, sessionId: string, recipient: string) =>
      path.join(
        recallDir,
        `${sessionKey(host, sessionId)}-${recipient.replace(/[^A-Za-z0-9._-]/g, "_")}.json`,
      );
    const decodeRecord = Schema.decodeUnknown(Schema.parseJson(CaptureRecord));

    return {
      home,
      pendingDir,
      withLock,
      readRecall: (host: Host, sessionId: string, recipient: string) =>
        readJson(RecallState, recallPath(host, sessionId, recipient)).pipe(
          Effect.map(Option.getOrElse(() => EMPTY_RECALL_STATE)),
        ),
      writeRecall: (host: Host, sessionId: string, recipient: string, state: RecallState) =>
        writeJson(RecallState, recallPath(host, sessionId, recipient), state),
      listRecalls: ensureDir(recallDir).pipe(Effect.zipRight(fs.readDirectory(recallDir))),
      readRecallFile: (name: string) =>
        readJson(RecallState, path.join(recallDir, path.basename(name))),
      listStates: ensureDir(sessionsDir).pipe(Effect.zipRight(fs.readDirectory(sessionsDir))),
      readStateFile: (name: string) =>
        readJson(SessionState, path.join(sessionsDir, path.basename(name))),

      readAuth: readJson(AuthFile, authPath).pipe(
        Effect.map(Option.getOrElse((): AuthFile => ({}))),
      ),
      writeAuth: (file: AuthFile) =>
        writeJson(AuthFile, authPath, file, { mode: OWNER_ONLY }).pipe(
          Effect.zipRight(fs.chmod(authPath, OWNER_ONLY).pipe(Effect.ignore)),
        ),
      clearAuth: fs.remove(authPath).pipe(Effect.ignore),
      readState: (host: Host, sessionId: string) =>
        readJson(SessionState, statePath(host, sessionId)),
      writeState: (state: SessionState) =>
        writeJson(SessionState, statePath(state.host, state.sessionId), state),
      appendRecord: (host: Host, sessionId: string, record: CaptureRecord) =>
        Schema.encode(Schema.parseJson(CaptureRecord))(record).pipe(
          Effect.flatMap((line) => appendLine(logPath(host, sessionId), line)),
        ),
      readRecords: (host: Host, sessionId: string) =>
        fs.readFileString(logPath(host, sessionId)).pipe(
          Effect.flatMap((text) =>
            Effect.forEach(
              text.split("\n").filter((line) => line.trim()),
              (line) => decodeRecord(line),
            ),
          ),
          Effect.catchTag("SystemError", (error) =>
            error.reason === "NotFound"
              ? Effect.succeed(Array.empty<CaptureRecord>())
              : Effect.fail(error),
          ),
        ),
      isPaused: fs.exists(pausedPath),
      setPaused: (paused: boolean) =>
        paused
          ? ensureDir(home).pipe(Effect.zipRight(fs.writeFileString(pausedPath, "")))
          : fs.remove(pausedPath, { force: true }),
      logError: (scope: string, error: unknown) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            appendLine(
              errorLogPath,
              `${DateTime.formatIso(now)} ${scope}: ${error instanceof Error ? error.name : "operation failed"}`,
            ),
          ),
        ),
      listPending: ensureDir(pendingDir).pipe(Effect.zipRight(fs.readDirectory(pendingDir))),
      readHandoff: (file: string) => readJson(Handoff, file),
      writeHandoff: (file: string, handoff: Handoff) => writeJson(Handoff, file, handoff),
    } as const;
  }),
  dependencies: [NodeFileSystem.layer, NodePath.layer],
}) {}

import { homedir } from "node:os";
import { FileSystem, Path } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Array, DateTime, Effect, Option, Schema } from "effect";
import { AgentHome } from "#config";
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
    const pendingDir = path.join(home, "pending");
    const pausedPath = path.join(home, "paused");
    const authPath = path.join(home, "auth.json");
    const errorLogPath = path.join(home, "errors.log");
    const statePath = (host: Host, sessionId: string) =>
      path.join(sessionsDir, `${sessionKey(host, sessionId)}.state.json`);
    const logPath = (host: Host, sessionId: string) =>
      path.join(sessionsDir, `${sessionKey(host, sessionId)}.jsonl`);

    const ensureDir = (directory: string) =>
      fs.makeDirectory(directory, { recursive: true }).pipe(Effect.ignore);
    const readJson = <A, I>(schema: Schema.Schema<A, I>, file: string) =>
      fs
        .readFileString(file)
        .pipe(Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(schema))), Effect.option);
    const writeJson = <A, I>(
      schema: Schema.Schema<A, I>,
      file: string,
      value: A,
      options?: FileSystem.WriteFileStringOptions,
    ) =>
      Schema.encode(Schema.parseJson(schema, { space: 2 }))(value).pipe(
        Effect.flatMap((text) =>
          ensureDir(path.dirname(file)).pipe(
            Effect.zipRight(fs.writeFileString(file, `${text}\n`, options)),
          ),
        ),
        Effect.ignore,
      );
    const appendLine = (file: string, line: string) =>
      ensureDir(path.dirname(file)).pipe(
        Effect.zipRight(fs.writeFileString(file, `${line}\n`, { flag: "a" })),
        Effect.ignore,
      );
    const decodeRecord = Schema.decodeUnknownOption(Schema.parseJson(CaptureRecord));

    return {
      home,
      pendingDir,
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
          Effect.ignore,
        ),
      readRecords: (host: Host, sessionId: string) =>
        fs.readFileString(logPath(host, sessionId)).pipe(
          Effect.map((text) => Array.filterMap(text.split("\n"), (line) => decodeRecord(line))),
          Effect.orElseSucceed(() => Array.empty<CaptureRecord>()),
        ),
      isPaused: fs.exists(pausedPath).pipe(Effect.orElseSucceed(() => false)),
      setPaused: (paused: boolean) =>
        paused
          ? ensureDir(home).pipe(Effect.zipRight(fs.writeFileString(pausedPath, "")), Effect.ignore)
          : fs.remove(pausedPath).pipe(Effect.ignore),
      logError: (scope: string, error: unknown) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            appendLine(errorLogPath, `${DateTime.formatIso(now)} ${scope}: ${String(error)}`),
          ),
        ),
      listPending: ensureDir(pendingDir).pipe(
        Effect.zipRight(fs.readDirectory(pendingDir)),
        Effect.orElseSucceed(() => Array.empty<string>()),
      ),
      readHandoff: (file: string) => readJson(Handoff, file),
      writeHandoff: (file: string, handoff: Handoff) => writeJson(Handoff, file, handoff),
    } as const;
  }),
  dependencies: [NodeFileSystem.layer, NodePath.layer],
}) {}

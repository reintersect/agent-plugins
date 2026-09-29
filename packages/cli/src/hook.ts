import { Array, Clock, DateTime, Effect, Match, Option, Schema } from "effect";
import { Backend } from "#backend";
import { recordsFromTool } from "#capture";
import { captureRecords } from "#captureRecords";
import { CursorTranscriptPath, HostProjectDir } from "#config";
import { recoverPending, scheduleFlush } from "#flush";
import { gitInfo } from "#git";
import { queueWarning } from "#health";
import { type HookAction, type HookInput, normalizeHookInput, renderHookOutput } from "#hostEvents";
import { currentCredentialKey } from "#identity";
import { nativeCommandResult } from "#nativeCommand";
import { recall } from "#recall";
import { redactSecrets } from "#redact";
import type { CaptureRecord, Host, SessionState } from "#schema";
import { AgentStore, sessionKey } from "#store";
import {
  codexCommandResult,
  parseTranscriptRows,
  readTranscriptChunk,
  transcriptMessages,
} from "#transcript";

const isoNow = Effect.map(DateTime.now, DateTime.formatIso);

const freshState = (input: HookInput): SessionState => ({
  host: input.host,
  sessionId: input.sessionId,
  nextSeq: 0,
  flushedRecords: 0,
  exchanges: 0,
  pendingChars: 0,
  transcriptOffset: 0,
  injectedMemoryIds: [],
  firstPromptDone: false,
  promptVersion: 0,
  recentSignals: [],
  heldRecords: [],
});

const ensureState = (input: HookInput) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;

    const existing = yield* store.readState(input.host, input.sessionId);

    if (Option.isSome(existing)) return existing.value;

    const state = {
      ...freshState(input),
      credentialKey: yield* currentCredentialKey,
      apiUrl: yield* (yield* Backend).apiUrl,
      ...(yield* gitInfo(input.cwd)),
    };

    yield* store.writeState(state);

    return state;
  });

const onSessionStart = (input: HookInput) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;

    const state = yield* ensureState(input);
    const git = yield* gitInfo(input.cwd);
    const changedRepository = state.repository !== undefined && git.repository !== state.repository;
    yield* store.writeState({
      ...state,
      ...(changedRepository ? {} : git),
      scopeMismatch: state.scopeMismatch || changedRepository,
      scopeChanged: state.scopeChanged || changedRepository,
      lastHookAt: yield* Clock.currentTimeMillis,
    });
    return "";
  });

const onUserPrompt = (input: HookInput, prompt: string) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;

    const state = yield* ensureState(input);
    const text = redactSecrets(prompt).trim();
    const observedAt = yield* isoNow;
    const credentialKey = yield* currentCredentialKey;
    const git = yield* gitInfo(input.cwd);
    const changedRepository = state.repository !== undefined && git.repository !== state.repository;
    const scopeMismatch =
      input.host === "claudeCode" ||
      input.host === "codex" ||
      state.scopeMismatch ||
      state.scopeChanged ||
      changedRepository ||
      (state.credentialKey !== undefined && credentialKey !== state.credentialKey);

    yield* store
      .appendRecord(input.host, input.sessionId, { kind: "person", observedAt, text })
      .pipe(Effect.when(() => text.length > 0 && !scopeMismatch));
    yield* store.writeState({
      ...state,
      ...(changedRepository ? {} : git),
      scopeMismatch,
      scopeChanged: state.scopeChanged || changedRepository,
      heldRecords:
        scopeMismatch && text
          ? [
              ...state.heldRecords,
              {
                credentialKey,
                promptVersion: state.promptVersion + 1,
                record: { kind: "person", observedAt, text },
              },
            ]
          : state.heldRecords,
      credentialKey: state.credentialKey ?? credentialKey,
      promptVersion: state.promptVersion + 1,
      skipTranscript: false,
      pendingChars: state.pendingChars + text.length,
      previousPromptText: state.lastPromptText,
      lastPromptText: text,
      recentSignals: [],
      lastHookAt: yield* Clock.currentTimeMillis,
      pendingSince: state.pendingSince ?? (yield* Clock.currentTimeMillis),
    });
    return "";
  });

const onTool = (input: HookInput, action: Extract<HookAction, { _tag: "Tool" }>) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;

    const state = yield* ensureState(input);

    const capture = yield* Effect.gen(function* () {
      if (input.host === "codex" && action.toolName === "Bash" && action.failed === undefined) {
        const native = nativeCommandResult(action.toolResponse);
        if (Option.isSome(native))
          return Option.some({
            ...action,
            failed: native.value.exit_code !== 0,
            toolResponse: native.value.aggregated_output,
          });

        // ponytail: rescan this turn's suffix; index by tool id if large turns make this costly.
        const chunk = input.transcriptPath
          ? yield* readTranscriptChunk(
              input.transcriptPath,
              state.transcriptPath === input.transcriptPath ? state.transcriptOffset : 0,
            )
          : { text: "" };
        const result = codexCommandResult(chunk.text, input.toolUseId);

        if (Option.isNone(result)) {
          yield* store.logError("capture codex_completion_missing", new Error());
          return Option.none<Extract<HookAction, { _tag: "Tool" }>>();
        }

        return Option.some({
          ...action,
          failed: result.value.exit_code !== 0,
          toolResponse: result.value.aggregated_output,
        });
      }
      return Option.some(action);
    });

    if (Option.isNone(capture)) return "";

    const observedAt = yield* isoNow;
    const records = recordsFromTool({ ...capture.value, cwd: input.cwd, observedAt });

    const captured = yield* captureRecords({ input, state, records });
    const signals = records.flatMap((record) => {
      if (record.kind === "file") return [`File ${record.action}: ${record.path}`];
      if (record.kind === "command" && record.failed)
        return [`Failed command: ${record.command.slice(0, 200)} ${record.output ?? ""}`];
      return [];
    });
    yield* store.writeState({
      ...captured,
      recentSignals: [...state.recentSignals, ...signals].slice(-6),
      pendingSince: state.pendingSince ?? (yield* Clock.currentTimeMillis),
      lastHookAt: yield* Clock.currentTimeMillis,
    });

    return "";
  });

const transcriptRecords = (input: HookInput, state: SessionState, fallback: string) =>
  Effect.gen(function* () {
    if (
      (input.host !== "claudeCode" && input.host !== "codex") ||
      input.transcriptPath === undefined
    ) {
      return {
        records: Array.empty<CaptureRecord>(),
        offset: state.transcriptOffset,
        leafUuid: "",
      };
    }

    const sameFile = state.transcriptPath === input.transcriptPath;
    const chunk = yield* readTranscriptChunk(
      input.transcriptPath,
      sameFile ? state.transcriptOffset : 0,
    );

    if (input.host === "codex" || !chunk.text) {
      return { records: Array.empty<CaptureRecord>(), offset: chunk.endOffset, leafUuid: "" };
    }

    const extraction = transcriptMessages({
      rows: parseTranscriptRows(chunk.text),
      sessionId: input.sessionId,
      ...(sameFile && state.transcriptLeafUuid
        ? { previousLeafUuid: state.transcriptLeafUuid }
        : {}),
      ...(state.lastPromptText ? { promptHint: state.lastPromptText } : {}),
      fallbackAssistantMessage: fallback,
    });
    const observedAt = yield* isoNow;
    const records = extraction.messages
      .filter((message) => !(message.role === "user" && message.content === state.lastPromptText))
      .map(
        (message): CaptureRecord => ({
          kind: message.role === "user" ? "person" : "agent",
          observedAt,
          text: message.content,
        }),
      );

    return { records, offset: chunk.endOffset, leafUuid: extraction.leafUuid };
  });

const messageChars = (records: ReadonlyArray<CaptureRecord>) =>
  records.reduce(
    (total, record) =>
      total + (record.kind === "file" || record.kind === "command" ? 0 : record.text.length),
    0,
  );

const onAssistantStop = (input: HookInput, text: string) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;

    const state = yield* ensureState(input);

    const fallback = redactSecrets(text).trim();
    const fromTranscript = yield* transcriptRecords(input, state, fallback).pipe(
      Effect.when(() => !state.skipTranscript),
      Effect.map(
        Option.getOrElse(() => ({
          records: Array.empty<CaptureRecord>(),
          offset: state.transcriptOffset,
          leafUuid: "",
        })),
      ),
    );
    const observedAt = yield* isoNow;
    const records = Array.isNonEmptyReadonlyArray(fromTranscript.records)
      ? fromTranscript.records
      : Array.fromOption(
          Option.liftPredicate(fallback, (value) => value.length > 0).pipe(
            Option.map((value): CaptureRecord => ({ kind: "agent", observedAt, text: value })),
          ),
        );

    const captured = yield* captureRecords({ input, state, records });

    const exchanges = state.exchanges + 1;
    const pendingChars = state.pendingChars + messageChars(records);

    yield* store.writeState({
      ...captured,
      exchanges,
      pendingChars,
      pendingSince: state.pendingSince ?? (yield* Clock.currentTimeMillis),
      ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
      transcriptOffset: fromTranscript.offset,
      ...(fromTranscript.leafUuid ? { transcriptLeafUuid: fromTranscript.leafUuid } : {}),
    });
    return "";
  });

const onSubagentStop = (input: HookInput, agentType: string, text: string) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;

    const body = redactSecrets(text).trim();

    if (!body) return "";

    const state = yield* ensureState(input);

    const observedAt = yield* isoNow;

    const captured = yield* captureRecords({
      input,
      state,
      records: [
        {
          kind: "agent",
          observedAt,
          text: `Subagent (${agentType}) result:\n${body}`,
        },
      ],
    });
    yield* store.writeState(captured);

    return "";
  });

const parseStdin = Schema.decodeUnknownOption(Schema.parseJson());

export const runHook = (host: Host, event: string, stdin: string) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;
    const cwd = yield* HostProjectDir;
    const transcriptPath = yield* CursorTranscriptPath;

    const input = normalizeHookInput({
      host,
      event,
      raw: Option.getOrElse(parseStdin(stdin), () => ({})),
      fallbacks: { cwd, transcriptPath },
    });

    if (yield* store.isPaused) return Option.none<string>();

    if (input.sessionId === "unknown-session") return Option.none<string>();

    const startedAt = yield* Clock.currentTimeMillis;
    yield* store.withLock(
      sessionKey(host, input.sessionId),
      Match.value(input.action).pipe(
        Match.tag("SessionStart", () => onSessionStart(input)),
        Match.tag("UserPrompt", (action) => onUserPrompt(input, action.prompt)),
        Match.tag("Tool", (action) => onTool(input, action)),
        Match.tag("AssistantStop", (action) => onAssistantStop(input, action.text)),
        Match.tag("SubagentStop", (action) => onSubagentStop(input, action.agentType, action.text)),
        Match.orElse(() => ensureState(input).pipe(Effect.as(""))),
      ),
    );

    const injecting = ["SessionStart", "UserPrompt", "SubagentStart", "Refresh"].includes(
      input.action._tag,
    );
    const flush =
      input.action._tag === "Flush" ||
      input.action._tag === "AssistantStop" ||
      input.action._tag === "SubagentStop" ||
      input.action._tag === "Refresh";

    yield* scheduleFlush({ host, sessionId: input.sessionId, reason: event }).pipe(
      Effect.when(() => flush),
      Effect.ignore,
    );
    yield* recoverPending.pipe(
      Effect.when(() => injecting || flush),
      Effect.ignore,
    );
    const warning = yield* queueWarning(input).pipe(
      Effect.when(() => injecting && input.action._tag !== "Refresh"),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const output = yield* Effect.if(injecting, {
      onTrue: () => recall(input, startedAt),
      onFalse: () => Effect.succeed({ context: "", warning: undefined }),
    });
    return renderHookOutput(
      host,
      event,
      output.context,
      output.warning ?? Option.getOrUndefined(warning),
    );
  }).pipe(
    Effect.timeoutOption(
      event === "background-recall" || event === "session-start" || event === "sessionStart"
        ? "19 seconds"
        : "4 seconds",
    ),
    Effect.map(Option.flatten),
    Effect.catchAll((error) =>
      AgentStore.pipe(
        Effect.flatMap((store) =>
          store.logError(`hook ${host} ${event}`, error).pipe(Effect.ignore),
        ),
        Effect.as(Option.none<string>()),
      ),
    ),
  );

import { Array, DateTime, Duration, Effect, Match, Option, Schema } from "effect";
import { Backend, hasCredentials } from "#backend";
import { recordsFromTool } from "#capture";
import { CursorTranscriptPath, HostProjectDir, MAX_MESSAGE_CHARS } from "#config";
import { recoverPending, scheduleFlush } from "#flush";
import { gitInfo } from "#git";
import { type HookAction, type HookInput, normalizeHookInput, renderHookOutput } from "#hostEvents";
import { boundedText, redactSecrets } from "#redact";
import { type CaptureRecord, type Host, RecallResult, type SessionState } from "#schema";
import { AgentStore } from "#store";
import { parseTranscriptRows, readTranscriptChunk, transcriptMessages } from "#transcript";

const RECALL_TIMEOUT = Duration.seconds(4);

const MIN_RECALL_PROMPT_CHARS = 20;

const MAX_RECALL_QUERY_CHARS = 2_000;

const RECALL_LIMIT = 8;

const FLUSH_EXCHANGE_THRESHOLD = 5;

const FLUSH_CHAR_THRESHOLD = 40_000;

const EMPTY_RECALL = { context: "", memoryIds: Array.empty<string>() };

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
});

const ensureState = (input: HookInput) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;

    const existing = yield* store.readState(input.host, input.sessionId);

    if (Option.isSome(existing)) return existing.value;

    const state = { ...freshState(input), ...(yield* gitInfo(input.cwd)) };

    yield* store.writeState(state);

    return state;
  });

export const withoutInjectedIds = (context: string, injected: ReadonlySet<string>) => {
  if (context.length === 0 || injected.size === 0) return context;

  const kept = context.split("\n").filter((line) => {
    const id = line.match(/\bid ([A-Za-z0-9_-]+)\)?\s*$/)?.[1];

    return id === undefined || !injected.has(id);
  });

  return kept.some((line) => line.trimStart().startsWith("- ")) ? kept.join("\n") : "";
};

const tryRecall = (state: SessionState, prompt: string) =>
  Effect.gen(function* () {
    const backend = yield* Backend;
    const store = yield* AgentStore;

    const injected = new Set(state.injectedMemoryIds);

    return yield* backend
      .callTool(
        "RecallForCodingSession",
        {
          prompt: redactSecrets(prompt).slice(0, MAX_RECALL_QUERY_CHARS),
          host: state.host,
          ...(state.repository === undefined ? {} : { repository: state.repository }),
          ...(state.branch === undefined ? {} : { branch: state.branch }),
          limit: RECALL_LIMIT,
        },
        "Recalling what Reintersect already knows before this local coding turn",
        RecallResult,
      )
      .pipe(
        Effect.timeout(RECALL_TIMEOUT),
        Effect.map((result) => ({
          context: withoutInjectedIds(result.context.trim(), injected),
          memoryIds: result.memoryIds,
        })),
        Effect.catchAll((error) => store.logError("recall", error).pipe(Effect.as(EMPTY_RECALL))),
      );
  });

const rememberInjected = (state: SessionState, memoryIds: ReadonlyArray<string>) =>
  Array.dedupe([...state.injectedMemoryIds, ...memoryIds]);

const onSessionStart = (input: HookInput) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;

    yield* recoverPending.pipe(Effect.ignore);

    const existing = yield* store.readState(input.host, input.sessionId);
    const state = {
      ...Option.getOrElse(existing, () => freshState(input)),
      ...(yield* gitInfo(input.cwd)),
    };

    yield* store.writeState(state);

    if (!(yield* hasCredentials)) return "";

    const where = state.repository
      ? `starting a session in ${state.repository}${state.branch ? ` on branch ${state.branch}` : ""}`
      : `starting a coding session in ${input.cwd}`;
    const result = yield* tryRecall(state, where);

    yield* Effect.when(
      store.writeState({ ...state, injectedMemoryIds: rememberInjected(state, result.memoryIds) }),
      () => result.context.length > 0,
    );

    return result.context;
  });

const onUserPrompt = (input: HookInput, prompt: string) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;

    const state = yield* ensureState(input);
    const text = boundedText(prompt, MAX_MESSAGE_CHARS);
    const observedAt = yield* isoNow;

    yield* Effect.when(
      store.appendRecord(input.host, input.sessionId, { kind: "person", observedAt, text }),
      () => text.length > 0,
    );

    const eligible =
      input.host !== "cursor" &&
      !state.firstPromptDone &&
      text.length >= MIN_RECALL_PROMPT_CHARS &&
      (yield* hasCredentials);
    const result = yield* Effect.if(eligible, {
      onTrue: () => tryRecall(state, text),
      onFalse: () => Effect.succeed(EMPTY_RECALL),
    });

    yield* store.writeState({
      ...state,
      firstPromptDone: state.firstPromptDone || eligible,
      pendingChars: state.pendingChars + text.length,
      lastPromptText: text,
      injectedMemoryIds: rememberInjected(state, result.memoryIds),
    });

    return result.context;
  });

const onTool = (input: HookInput, action: Extract<HookAction, { _tag: "Tool" }>) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;

    yield* ensureState(input);

    const observedAt = yield* isoNow;
    const records = recordsFromTool({ ...action, cwd: input.cwd, observedAt });

    yield* Effect.forEach(
      records,
      (record) => store.appendRecord(input.host, input.sessionId, record),
      { discard: true },
    );

    return "";
  });

const transcriptRecords = (input: HookInput, state: SessionState, fallback: string) =>
  Effect.gen(function* () {
    if (input.host !== "claudeCode" || input.transcriptPath === undefined) {
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

    if (!chunk.text) {
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
    const fallback = boundedText(text, MAX_MESSAGE_CHARS);
    const fromTranscript = yield* transcriptRecords(input, state, fallback);
    const observedAt = yield* isoNow;
    const records = Array.isNonEmptyReadonlyArray(fromTranscript.records)
      ? fromTranscript.records
      : Array.fromOption(
          Option.liftPredicate(fallback, (value) => value.length > 0).pipe(
            Option.map((value): CaptureRecord => ({ kind: "agent", observedAt, text: value })),
          ),
        );

    yield* Effect.forEach(
      records,
      (record) => store.appendRecord(input.host, input.sessionId, record),
      { discard: true },
    );

    const exchanges = state.exchanges + 1;
    const pendingChars = state.pendingChars + messageChars(records);

    yield* store.writeState({
      ...state,
      exchanges,
      pendingChars,
      ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
      transcriptOffset: fromTranscript.offset,
      ...(fromTranscript.leafUuid ? { transcriptLeafUuid: fromTranscript.leafUuid } : {}),
    });
    yield* Effect.when(
      scheduleFlush({ host: input.host, sessionId: input.sessionId, reason: "threshold" }).pipe(
        Effect.ignore,
      ),
      () => exchanges >= FLUSH_EXCHANGE_THRESHOLD || pendingChars >= FLUSH_CHAR_THRESHOLD,
    );

    return "";
  });

const onSubagentStop = (input: HookInput, agentType: string, text: string) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;

    const body = boundedText(text, MAX_MESSAGE_CHARS);

    if (!body) return "";

    yield* ensureState(input);

    const observedAt = yield* isoNow;

    yield* store.appendRecord(input.host, input.sessionId, {
      kind: "agent",
      observedAt,
      text: `Subagent (${agentType}) result:\n${body}`,
    });

    return "";
  });

const onFlush = (input: HookInput, reason: string) =>
  ensureState(input).pipe(
    Effect.zipRight(
      scheduleFlush({ host: input.host, sessionId: input.sessionId, reason }).pipe(Effect.ignore),
    ),
    Effect.as(""),
  );

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

    const context = yield* Match.value(input.action).pipe(
      Match.tag("SessionStart", () => onSessionStart(input)),
      Match.tag("UserPrompt", (action) => onUserPrompt(input, action.prompt)),
      Match.tag("Tool", (action) => onTool(input, action)),
      Match.tag("AssistantStop", (action) => onAssistantStop(input, action.text)),
      Match.tag("SubagentStop", (action) => onSubagentStop(input, action.agentType, action.text)),
      Match.tag("Flush", (action) => onFlush(input, action.reason)),
      Match.tag("Ignore", () => Effect.succeed("")),
      Match.exhaustive,
    );

    return renderHookOutput(host, event, context);
  }).pipe(
    Effect.catchAll((error) =>
      AgentStore.pipe(
        Effect.flatMap((store) => store.logError(`hook ${host} ${event}`, error)),
        Effect.as(Option.none<string>()),
      ),
    ),
  );

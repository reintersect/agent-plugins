import { randomUUID } from "node:crypto";
import { Clock, Effect, Option } from "effect";
import { Backend } from "#backend";
import { gitInfo } from "#git";
import type { HookInput } from "#hostEvents";
import { currentCredentialKey } from "#identity";
import { recallDelta } from "#recallContext";
import {
  EMPTY_RECALL_STATE,
  RecallResult,
  type RecallState,
  type RecallTrigger,
} from "#recallSchema";
import { redactSecrets } from "#redact";
import { AgentStore, sessionKey } from "#store";

const BACKGROUND_INTERVAL_MS = 60_000;
const EMPTY_OUTPUT = { context: "", warning: undefined as string | undefined };

const failureCategory = (error: {
  readonly _tag: string;
  readonly category?: string;
}): NonNullable<RecallState["failure"]> => {
  if (error._tag === "NotAuthenticatedError") return "authentication";
  if (error._tag === "TimeoutException") return "timeout";
  if (error.category === "schema") return "server_upgrade";
  return "unavailable";
};

const partialFailure = (status: "complete" | "partial") =>
  status === "partial" ? ("partial" as const) : undefined;

const triggerFor = (input: HookInput): RecallTrigger => {
  if (input.action._tag === "UserPrompt") return "prompt";
  if (input.action._tag === "Refresh") return "background";
  if (input.action._tag === "SubagentStart") return "subagent";
  if (input.source === "compact") return "compact";
  if (input.source === "resume") return "resume";
  return "startup";
};

export const recall = (input: HookInput, startedAt: number) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;
    const backend = yield* Backend;

    const recipient = input.agentId ?? "main";
    const key = `recall-${sessionKey(input.host, input.sessionId)}-${recipient}`;
    const trigger = triggerFor(input);
    const background =
      trigger === "background" || (trigger === "startup" && input.source !== "clear");
    const credentialKey = yield* currentCredentialKey;
    const git = yield* gitInfo(input.cwd);
    const prepared = yield* store.withLock(
      key,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const state = yield* store.readState(input.host, input.sessionId);
        const saved = yield* store.readRecall(input.host, input.sessionId, recipient);

        if (Option.isNone(state)) return Option.none();
        if (input.host === "cursor" && input.action._tag !== "SessionStart") return Option.none();
        if (
          input.host === "opencode" &&
          trigger === "prompt" &&
          (state.value.firstPromptDone || (state.value.lastPromptText?.length ?? 0) < 20)
        )
          return Option.none();
        if (
          trigger === "startup" &&
          input.source !== "clear" &&
          input.source !== "fork" &&
          state.value.promptVersion > 0
        )
          return Option.none();
        if (
          background &&
          saved.lastAttempt !== undefined &&
          now - saved.lastAttempt < BACKGROUND_INTERVAL_MS
        )
          return Option.none();

        const changedIdentity =
          saved.credentialKey !== credentialKey || saved.repository !== git.repository;
        const reset =
          changedIdentity ||
          trigger === "compact" ||
          trigger === "resume" ||
          trigger === "subagent" ||
          input.source === "clear" ||
          input.source === "fork";
        const previous = reset
          ? { ...saved, generation: saved.generation + 1, emitted: [] }
          : saved;
        const next: RecallState = {
          ...previous,
          requestId: randomUUID(),
          lastAttempt: now,
          lastTrigger: trigger,
          taskVersion: state.value.promptVersion,
          credentialKey,
          repository: git.repository,
          resetScopePending:
            saved.resetScopePending || (changedIdentity && saved.emitted.length > 0),
        };
        const latest = state.value.lastPromptText ?? "";
        const query = [
          trigger === "subagent" ? `Subagent task: ${input.agentType ?? "agent"}` : "",
          latest.slice(0, 1200) || `Working in ${git.repository ?? input.cwd}`,
          latest.length < 80 ? (state.value.previousPromptText ?? "").slice(0, 500) : "",
          ...state.value.recentSignals.slice(-6).map((signal) => signal.slice(0, 200)),
        ]
          .filter(Boolean)
          .join("\n");

        yield* store.writeRecall(input.host, input.sessionId, recipient, next);
        return Option.some({
          state: state.value,
          request: next,
          query: redactSecrets(query).slice(0, 2000),
          scopeReset: next.resetScopePending === true,
        });
      }),
    );
    if (Option.isNone(prepared)) return EMPTY_OUTPUT;

    const { state, request, query, scopeReset } = prepared.value;
    const now = yield* Clock.currentTimeMillis;
    const budget = background ? 15_000 : Math.max(1, 3900 - (now - startedAt));
    const result = yield* backend
      .callTool(
        "RecallForCodingSession",
        {
          prompt: query,
          host: input.host,
          repository: git.repository,
          branch: git.branch,
          trigger,
          knownMemoryIds: request.emitted.flatMap(({ memoryId }) =>
            memoryId === undefined ? [] : [memoryId],
          ),
          knownProfileKeys: request.emitted
            .filter(({ kind }) => kind === "profile")
            .map(({ key }) => key),
          limit: 8,
        },
        "Recalling relevant knowledge for the current coding task",
        RecallResult,
      )
      .pipe(Effect.timeout(`${budget} millis`), Effect.either);

    return yield* store.withLock(
      key,
      Effect.gen(function* () {
        const current = yield* store.readRecall(input.host, input.sessionId, recipient);
        const currentSession = yield* store.readState(input.host, input.sessionId);
        const currentIdentity = yield* currentCredentialKey;
        const completedAt = yield* Clock.currentTimeMillis;

        if (
          current.requestId !== request.requestId ||
          currentIdentity !== credentialKey ||
          (yield* store.isPaused)
        )
          return EMPTY_OUTPUT;
        if (
          Option.isNone(currentSession) ||
          currentSession.value.promptVersion !== request.taskVersion
        )
          return EMPTY_OUTPUT;

        if (result._tag === "Left") {
          const error = result.left;
          const failure = failureCategory(error);
          const failures = current.failures + 1;
          const warn =
            !background &&
            !current.warned &&
            (failure === "authentication" || failure === "server_upgrade" || failures >= 3);
          const warning = warn
            ? `Reintersect automatic memory is unavailable (${failure}). Run the Reintersect status skill for recovery steps.`
            : undefined;
          yield* store.writeRecall(input.host, input.sessionId, recipient, {
            ...current,
            requestId: undefined,
            failures,
            failure,
            warned: current.warned || warn,
          });
          yield* store.logError("recall", error).pipe(Effect.ignore);
          return { context: "", warning };
        }

        const response = result.right;
        const scopeChanged =
          current.scopeKey !== undefined && current.scopeKey !== response.scopeKey;
        const previous = scopeChanged ? { ...EMPTY_RECALL_STATE, emitted: [] } : current;
        const delta = recallDelta({
          items: response.items,
          invalidatedMemoryIds: response.invalidatedMemoryIds,
          invalidatedProfileKeys: response.invalidatedProfileKeys,
          previous,
          resetScope: scopeChanged || scopeReset,
        });
        const apiUrl = yield* backend.apiUrl;
        const scopeMismatch =
          state.scopeChanged === true ||
          (state.scopeKey !== undefined && state.scopeKey !== response.scopeKey) ||
          (state.apiUrl !== undefined && state.apiUrl !== apiUrl) ||
          state.repository !== git.repository;
        const partial = response.status === "partial";
        const failures = partial ? current.failures + 1 : 0;
        const warn = !background && !current.warned && (scopeMismatch || failures >= 3);

        const finalized = yield* store.withLock(
          sessionKey(input.host, input.sessionId),
          Effect.gen(function* () {
            const latest = yield* store.readState(input.host, input.sessionId);
            if (
              Option.isNone(latest) ||
              latest.value.promptVersion !== request.taskVersion ||
              (latest.value.scopeChanged && !scopeMismatch)
            )
              return false;
            const settled = latest.value.heldRecords.filter(
              (held) =>
                !scopeMismatch &&
                held.credentialKey === credentialKey &&
                held.promptVersion === request.taskVersion,
            );
            yield* Effect.forEach(
              settled,
              ({ record }) => store.appendRecord(input.host, input.sessionId, record),
              { discard: true },
            );
            yield* store.writeState({
              ...latest.value,
              heldRecords: latest.value.heldRecords.filter((held) => !settled.includes(held)),
              firstPromptDone:
                latest.value.firstPromptDone || (input.host === "opencode" && trigger === "prompt"),
              scopeKey: latest.value.scopeKey ?? response.scopeKey,
              credentialKey: scopeMismatch ? latest.value.credentialKey : credentialKey,
              apiUrl: latest.value.apiUrl ?? apiUrl,
              scopeMismatch,
              scopeChanged: latest.value.scopeChanged || scopeMismatch,
            });
            return true;
          }),
        );
        if (!finalized) return EMPTY_OUTPUT;
        yield* store.writeRecall(input.host, input.sessionId, recipient, {
          ...current,
          scopeKey: response.scopeKey,
          resetScopePending: false,
          emitted: delta.emitted,
          durationMs: completedAt - now,
          requestId: undefined,
          lastSuccess: partial ? current.lastSuccess : completedAt,
          lastEmission: delta.context ? completedAt : current.lastEmission,
          lastContext: delta.context || current.lastContext,
          failures,
          failure: scopeMismatch ? "scope_changed" : partialFailure(response.status),
          warned: (partial || scopeMismatch) && (current.warned || warn),
        });
        return {
          context: delta.context,
          warning: warn
            ? "Reintersect memory needs attention. Run the status skill; if the workspace changed, start a new session so captured work stays in its original workspace."
            : undefined,
        };
      }),
    );
  });

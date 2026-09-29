import { Path } from "@effect/platform";
import { Clock, Effect, Option } from "effect";
import type { HookInput } from "#hostEvents";
import { AgentStore, sessionKey } from "#store";

export const queueWarning = (input: HookInput) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;
    return yield* store.withLock(
      sessionKey(input.host, input.sessionId),
      Effect.gen(function* () {
        const state = yield* store.readState(input.host, input.sessionId);
        const now = yield* Clock.currentTimeMillis;
        if (
          Option.isNone(state) ||
          state.value.queueWarned ||
          state.value.pendingSince === undefined ||
          now - state.value.pendingSince < 300_000
        )
          return undefined;

        yield* store.writeState({ ...state.value, queueWarned: true });
        return "Reintersect has captured work waiting more than five minutes to upload. It is retained locally. Run the Reintersect status skill for recovery steps.";
      }),
    );
  });

const when = (value: number | undefined) =>
  value === undefined ? "never" : new Date(value).toISOString();

export const healthLines = Effect.gen(function* () {
  const store = yield* AgentStore;
  const now = yield* Clock.currentTimeMillis;
  const path = yield* Path.Path;
  const pending = (yield* Effect.forEach(
    (yield* store.listPending).filter((name) => /\.(json|running)$/.test(name)),
    (name) => store.readHandoff(path.join(store.pendingDir, name)),
  )).flatMap(Option.toArray);
  const unbound = pending.filter(
    ({ snapshot }) => snapshot?.scopeKey === undefined || snapshot.apiUrl === undefined,
  ).length;
  const sessions = (yield* Effect.forEach(
    (yield* store.listStates).filter((name) => name.endsWith(".state.json")),
    store.readStateFile,
  )).flatMap(Option.toArray);
  const recalls = (yield* Effect.forEach(
    (yield* store.listRecalls).filter((name) => name.endsWith(".json")),
    (name) => store.readRecallFile(name).pipe(Effect.map(Option.map((state) => ({ name, state })))),
  )).flatMap(Option.toArray);
  const latest = recalls.toSorted(
    (a, b) => (b.state.lastAttempt ?? 0) - (a.state.lastAttempt ?? 0),
  )[0];
  const oldest = sessions
    .flatMap((state) => (state.pendingSince === undefined ? [] : [state.pendingSince]))
    .toSorted((a, b) => a - b)[0];
  const held = sessions.filter(
    (state) =>
      state.scopeMismatch || (state.pendingSince !== undefined && state.scopeKey === undefined),
  ).length;
  const hosts = [...new Set(sessions.map(({ host }) => host))];

  return [
    ...hosts.map(
      (host) =>
        `${host} last hook    ${when(Math.max(...sessions.filter((state) => state.host === host).map((state) => state.lastHookAt ?? 0)) || undefined)}`,
    ),
    `Recall last attempt   ${when(latest?.state.lastAttempt)}`,
    `Recall last success   ${when(latest?.state.lastSuccess)}`,
    `Recall last output    ${when(latest?.state.lastEmission)} (output produced; host receipt unverified)`,
    `Recall condition      ${latest?.state.failure ?? "healthy or not yet attempted"}; ${latest?.state.failures ?? 0} consecutive failures`,
    `Recall duration       ${latest?.state.durationMs ?? "unknown"} ms`,
    `Oldest unsent capture ${oldest === undefined ? "none" : `${Math.floor((now - oldest) / 60_000)} minutes`}`,
    `Scope-held sessions   ${held}`,
    `Unbound old batches   ${unbound} (preserved locally; original ownership needs review)`,
    `Unassigned records    ${sessions.reduce((count, state) => count + state.heldRecords.length, 0)} (retained locally for review)`,
    ...(held > 0
      ? [
          "hint  sign in to the original account/workspace to retry its bound batches; start a new agent session after changing accounts or repositories",
        ]
      : []),
  ];
});

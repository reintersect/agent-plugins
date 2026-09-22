import { Array, Console, Effect, Option, Predicate } from "effect";
import { Backend, hasCredentials } from "#backend";
import { ApiKey, LOOPBACK_PORTS, trimSlash } from "#config";
import { LoginError } from "#errors";
import { LoopbackServer, runLogin } from "#login";
import { WorkspacesResult } from "#schema";
import { AgentStore } from "#store";

const workspaces = Backend.pipe(
  Effect.flatMap((backend) =>
    backend.callTool(
      "GetWorkspaces",
      {},
      "Checking which Reintersect workspace this machine's coding agent is signed in to",
      WorkspacesResult,
    ),
  ),
  Effect.map((result) => result.workspaces),
);

const currentWorkspace = (list: typeof WorkspacesResult.Type.workspaces) =>
  Array.findFirst(list, (workspace) => workspace.current === true).pipe(
    Option.orElse(() => Array.head(list)),
  );

export const login = (apiUrlFlag: Option.Option<string>) =>
  Effect.gen(function* () {
    const backend = yield* Backend;
    const apiKey = yield* ApiKey;

    const url = yield* Option.match(apiUrlFlag, {
      onSome: (flag) => Effect.succeed(trimSlash(flag)),
      onNone: () => backend.apiUrl,
    });

    if (Option.isSome(apiKey)) {
      yield* Console.log(`Using REINTERSECT_API_KEY against ${url}; no browser login needed.`);
      return;
    }

    yield* runLogin(url).pipe(
      Effect.scoped,
      Effect.provide(LoopbackServer),
      Effect.catchTag("ServeError", () =>
        Effect.fail(
          new LoginError({ message: `no free loopback port among ${LOOPBACK_PORTS.join(", ")}` }),
        ),
      ),
    );
    yield* Console.log(`Signed in to ${url}.`);
    yield* backend.initialize.pipe(Effect.ignore);

    const bound = yield* workspaces.pipe(Effect.orElseSucceed(() => []));

    yield* Option.match(currentWorkspace(bound), {
      onNone: () => Effect.void,
      onSome: (workspace) => Console.log(`Workspace: ${workspace.name || workspace.id}`),
    });
  });

export const logout = AgentStore.pipe(
  Effect.flatMap((store) => store.clearAuth),
  Effect.zipRight(Console.log("Signed out; local session capture files were left in place.")),
);

export const status = Effect.gen(function* () {
  const store = yield* AgentStore;
  const backend = yield* Backend;
  const apiKey = yield* ApiKey;

  const url = yield* backend.apiUrl;
  const signedIn = yield* hasCredentials;
  const paused = yield* store.isPaused;
  const pending = (yield* store.listPending).filter(
    (name) => name.endsWith(".json") || name.endsWith(".running"),
  ).length;
  const bound = yield* Effect.if(signedIn, {
    onTrue: () =>
      backend.initialize.pipe(Effect.ignore, Effect.zipRight(workspaces), Effect.option),
    onFalse: () => Effect.succeedNone,
  });
  const workspace = Option.flatMap(bound, currentWorkspace);
  const authentication = Option.match(apiKey, {
    onSome: () => "api-key",
    onNone: () => (signedIn ? "oauth" : "none"),
  });
  const lines = [
    `Capture setting       ${paused ? "paused" : "enabled (hook execution not verified)"}`,
    `API                   ${url}`,
    `Authentication        ${authentication}`,
    `Workspace             ${Option.match(workspace, { onNone: () => "unknown", onSome: (entry) => entry.name || entry.id })}`,
    `Pending flushes       ${pending}`,
    `Data directory        ${store.home}`,
    !signedIn && "hint  run the login command, or set REINTERSECT_API_KEY",
    signedIn && Option.isNone(bound) && `hint  the API at ${url} did not answer GetWorkspaces`,
    paused && "hint  capture is paused; run the resume command",
    pending > 0 && `hint  ${pending} batches are waiting; they retry on the next session start`,
    Option.isSome(workspace) &&
      "This machine is bound to one workspace. If this repository belongs to another one, call the SetWorkspace tool.",
  ].filter(Predicate.isString);

  yield* Effect.forEach(lines, (line) => Console.log(line), { discard: true });
});

export const setPaused = (paused: boolean) =>
  AgentStore.pipe(
    Effect.flatMap((store) => store.setPaused(paused)),
    Effect.zipRight(
      Console.log(
        paused
          ? "Capture paused. Existing memories stay searchable and pending batches are held, not dropped."
          : "Capture resumed.",
      ),
    ),
  );

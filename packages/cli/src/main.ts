import { parseArgs } from "node:util";
import { NodeRuntime, NodeSink, NodeStream } from "@effect/platform-node";
import { Console, Effect, Layer, Match, Option, Predicate, Schema } from "effect";
import { login, logout, setPaused, status } from "#commands";
import { CodexPluginRoot } from "#config";
import { UsageError } from "#errors";
import { runFlush } from "#flush";
import { runHook } from "#hook";
import { resolveHost } from "#hostEvents";
import { proxyLayer } from "#mcpProxy";
import { AppLive } from "#runtime";
import { Host } from "#schema";

const USAGE = `reintersect-agent <command>

  login [--api-url URL]      sign in once for every coding agent on this machine
  logout                     remove the stored credentials
  status                     show capture state, workspace, pending flushes and hints
  hook <host> <event>        run a host hook; reads the host payload on stdin
  flush <handoff.json>       ship one captured batch (usually run detached)
  mcp                        serve Reintersect's tools over stdio
  pause | resume             stop or restart local capture
`;

const readStdin = process.stdin.isTTY
  ? Effect.succeed("")
  : NodeStream.toString(() => process.stdin, { onFailure: () => "" }).pipe(
      Effect.orElseSucceed(() => ""),
    );

const hook = (host: string | undefined, event: string | undefined) =>
  Effect.gen(function* () {
    const parsedHost = Schema.decodeUnknownOption(Host)(host);

    if (Option.isNone(parsedHost) || event === undefined) {
      return yield* new UsageError({
        message: `unknown hook target: ${host ?? ""} ${event ?? ""}`,
      });
    }

    const stdin = yield* readStdin;
    const output = yield* runHook(
      resolveHost(parsedHost.value, yield* CodexPluginRoot),
      event,
      stdin,
    );

    yield* Option.match(output, { onNone: () => Effect.void, onSome: Console.log });
  });

const mcp = Layer.launch(proxyLayer({ stdin: NodeStream.stdin, stdout: NodeSink.stdout }));

const program = (argv: ReadonlyArray<string>) => {
  const { positionals, values } = parseArgs({
    args: [...argv],
    options: { "api-url": { type: "string" } },
    allowPositionals: true,
    strict: false,
  });

  return Match.value(positionals[0] ?? "").pipe(
    Match.when("login", () => login(Option.liftPredicate(values["api-url"], Predicate.isString))),
    Match.when("logout", () => logout),
    Match.when("status", () => status),
    Match.when("hook", () => hook(positionals[1], positionals[2])),
    Match.when("flush", () =>
      Option.match(Option.fromNullable(positionals[1]), {
        onNone: () => Effect.fail(new UsageError({ message: "flush needs a handoff file path" })),
        onSome: runFlush,
      }),
    ),
    Match.when("mcp", () => mcp),
    Match.when("pause", () => setPaused(true)),
    Match.when("resume", () => setPaused(false)),
    Match.orElse(() => Console.log(USAGE)),
  );
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const main = (argv: ReadonlyArray<string>) =>
  program(argv).pipe(
    Effect.catchAll((error) =>
      Console.error(errorMessage(error)).pipe(
        Effect.zipRight(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
    Effect.provide(AppLive),
  );

NodeRuntime.runMain(main(process.argv.slice(2)), { disableErrorReporting: true });

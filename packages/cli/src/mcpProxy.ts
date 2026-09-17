import { McpSchema, McpServer } from "@effect/ai";
import { Console, Deferred, Effect, Layer, Option, type Sink, Stream } from "effect";
import { Backend } from "#backend";
import { CLIENT_NAME, CLIENT_VERSION, HostProjectDir } from "#config";
import { gitRepository } from "#git";

const REPOSITORY_TOOL_NAMES = ["SearchMemories", "Remember", "RecallForCodingSession"];

export const withRepository = (
  toolName: string,
  args: Record<string, unknown>,
  repository: Option.Option<string>,
) =>
  Option.match(repository, {
    onNone: () => args,
    onSome: (value) =>
      REPOSITORY_TOOL_NAMES.includes(toolName) && args.repository === undefined
        ? { ...args, repository: value }
        : args,
  });

const errorResult = (message: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text: message }] });

export const registerBackendTools = Effect.gen(function* () {
  const registry = yield* McpServer.McpServer;
  const backend = yield* Backend;
  const cwd = yield* HostProjectDir;

  const repository = yield* gitRepository(cwd);
  const tools = yield* backend.listTools.pipe(
    Effect.tapError((error) => Console.error(`reintersect: ${error.message}`)),
    Effect.orElseSucceed(() => []),
  );

  yield* Effect.forEach(
    tools,
    (tool) =>
      registry.addTool({
        tool,
        handle: (payload: Record<string, unknown>) =>
          backend
            .call(tool.name, withRepository(tool.name, payload, repository))
            .pipe(Effect.catchAll((error) => Effect.succeed(errorResult(error.message)))),
      }),
    { discard: true },
  );
});

export interface ProxyIo<EIn, RIn, EOut, ROut> {
  readonly stdin: Stream.Stream<Uint8Array, EIn, RIn>;
  readonly stdout: Sink.Sink<unknown, Uint8Array | string, unknown, EOut, ROut>;
}

const FALLBACK_BRANDING = { title: "Reintersect", websiteUrl: "https://reintersect.com" };

const branding = Backend.pipe(
  Effect.flatMap((backend) => backend.serverInfo),
  Effect.map(({ description, icons, title, websiteUrl }) => ({
    title: title ?? FALLBACK_BRANDING.title,
    websiteUrl: websiteUrl ?? FALLBACK_BRANDING.websiteUrl,
    ...(description === undefined ? {} : { description }),
    ...(icons === undefined ? {} : { icons }),
  })),
  Effect.orElseSucceed(() => FALLBACK_BRANDING),
);

export const proxyLayer = <EIn, RIn, EOut, ROut>(io: ProxyIo<EIn, RIn, EOut, ROut>) =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const info = yield* branding;

      const stdin = Stream.unwrap(Effect.as(Deferred.await(ready), io.stdin));
      const registered = registerBackendTools.pipe(
        Effect.ensuring(Deferred.succeed(ready, undefined)),
      );

      return Layer.effectDiscard(registered).pipe(
        Layer.provide(
          McpServer.layerStdio({
            name: CLIENT_NAME,
            version: CLIENT_VERSION,
            ...info,
            stdin,
            stdout: io.stdout,
          }),
        ),
      );
    }),
  );

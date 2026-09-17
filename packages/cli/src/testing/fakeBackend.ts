import { createServer } from "node:http";
import { McpSchema, McpServer } from "@effect/ai";
import { HttpRouter, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";

export interface RecordedCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface FakeBackendOptions {
  readonly tools: ReadonlyArray<string>;
  readonly onCall: (call: RecordedCall) => unknown;
}

export interface FakeBackend {
  readonly url: string;
  readonly calls: RecordedCall[];
  readonly close: () => Promise<void>;
}

export const toolResult = (value: unknown) =>
  new McpSchema.CallToolResult({
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  });

export const FAKE_INPUT_SCHEMA = {
  type: "object",
  properties: { context: { type: "string" } },
  required: ["context"],
};

const fakeTool = (name: string) =>
  new McpSchema.Tool({ name, description: `${name} (fake)`, inputSchema: FAKE_INPUT_SCHEMA });

export const startFakeBackend = async (options: FakeBackendOptions): Promise<FakeBackend> => {
  const calls: RecordedCall[] = [];
  const tools = Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* McpServer.McpServer;

      yield* Effect.forEach(
        options.tools,
        (name) =>
          registry.addTool({
            tool: fakeTool(name),
            handle: (payload: Record<string, unknown>) => {
              const call = { name, arguments: payload };

              calls.push(call);

              return Effect.succeed(toolResult(options.onCall(call)));
            },
          }),
        { discard: true },
      );
    }),
  );
  const app = Layer.mergeAll(tools, HttpRouter.Default.serve()).pipe(
    Layer.provide(
      McpServer.layerHttp({
        name: "fake-reintersect",
        title: "Reintersect (fake)",
        version: "0.0.0",
        websiteUrl: "https://reintersect.test",
        icons: [{ src: "https://reintersect.test/logo.png", mimeType: "image/png" }],
        path: "/mcp",
      }),
    ),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
  );
  const runtime = ManagedRuntime.make(app);
  const port = await runtime.runPromise(
    HttpServer.addressWith((address) =>
      Effect.succeed(address._tag === "TcpAddress" ? address.port : 0),
    ),
  );

  return { url: `http://127.0.0.1:${port}`, calls, close: () => runtime.dispose() };
};

export const fakeBackend = (options: FakeBackendOptions) =>
  Effect.acquireRelease(
    Effect.promise(() => startFakeBackend(options)).pipe(
      Effect.tap((backend) =>
        Effect.sync(() => {
          process.env.REINTERSECT_API_URL = backend.url;
        }),
      ),
    ),
    (backend) => Effect.promise(backend.close),
  );

import { tmpdir } from "node:os";
import { it } from "@effect/vitest";
import { Effect, Layer, Queue, Sink, Stream } from "effect";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { CLIENT_NAME } from "#config";
import { proxyLayer } from "#mcpProxy";
import { AppLive } from "#runtime";
import {
  FAKE_INPUT_SCHEMA,
  type FakeBackendOptions,
  fakeBackend,
  startFakeBackend,
} from "#testing/fakeBackend";
import { makeAgentHome, makeGitRepo } from "#testing/harness";

const encoder = new TextEncoder();

const decoder = new TextDecoder();

interface JsonRpcReply {
  readonly id?: number;
  readonly result?: Record<string, unknown> & {
    readonly capabilities?: Record<string, unknown>;
    readonly tools?: ReadonlyArray<{ readonly name: string; readonly inputSchema: unknown }>;
    readonly serverInfo?: {
      readonly name: string;
      readonly title?: string;
      readonly icons?: unknown;
    };
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
  };
}

const startProxy = Effect.gen(function* () {
  const input = yield* Queue.unbounded<Uint8Array>();
  const output = yield* Queue.unbounded<Uint8Array | string>();

  yield* Layer.build(
    proxyLayer({ stdin: Stream.fromQueue(input), stdout: Sink.fromQueue(output) }).pipe(
      Layer.provide(AppLive),
    ),
  ).pipe(Effect.forkScoped);

  const replies = Stream.fromQueue(output).pipe(
    Stream.map((chunk) => (typeof chunk === "string" ? chunk : decoder.decode(chunk))),
    Stream.splitLines,
    Stream.map((line) => JSON.parse(line) as JsonRpcReply),
  );
  const request = (id: number, method: string, params: unknown) =>
    Queue.offer(
      input,
      encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`),
    ).pipe(
      Effect.zipRight(
        replies.pipe(
          Stream.filter((reply) => reply.id === id),
          Stream.runHead,
        ),
      ),
      Effect.map((reply) => (reply._tag === "Some" ? reply.value : {})),
    );

  const initialized = yield* request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });

  return { initialized, request };
});

const backend = (tools: FakeBackendOptions["tools"]) =>
  fakeBackend({ tools, onCall: () => ({ ok: true }) });

const env = { repo: "" };

beforeEach(() => {
  makeAgentHome();
  env.repo = makeGitRepo();
  process.env.REINTERSECT_API_KEY = "rei_testkeyvalue";
  process.env.CLAUDE_PROJECT_DIR = env.repo;
});

afterEach(() => {
  delete process.env.REINTERSECT_API_URL;
  delete process.env.REINTERSECT_API_KEY;
  delete process.env.CLAUDE_PROJECT_DIR;
});

describe("stdio proxy", () => {
  it.scopedLive("announces itself and forwards tools/list unchanged", () =>
    Effect.gen(function* () {
      yield* backend(["SearchMemories", "Remember", "SearchReintersect", "GetMoreTools"]);

      const proxy = yield* startProxy;
      const listed = yield* proxy.request(3, "tools/list", {});

      expect(proxy.initialized.result?.serverInfo?.name).toBe(CLIENT_NAME);
      expect(proxy.initialized.result?.serverInfo?.title).toBe("Reintersect (fake)");
      expect(proxy.initialized.result?.serverInfo?.icons).toEqual([
        { src: "https://reintersect.test/logo.png", mimeType: "image/png" },
      ]);
      expect(proxy.initialized.result?.capabilities).toMatchObject({ tools: {} });
      expect(listed.result?.tools?.map((tool) => tool.name)).toEqual([
        "SearchMemories",
        "Remember",
        "SearchReintersect",
        "GetMoreTools",
      ]);
      expect(listed.result?.tools?.[0]?.inputSchema).toEqual(FAKE_INPUT_SCHEMA);
    }),
  );

  it.scopedLive("adds the repository from the git remote only where the caller left it out", () =>
    Effect.gen(function* () {
      const server = yield* backend(["SearchMemories", "Remember", "GetWorkspaces"]);
      const proxy = yield* startProxy;

      yield* proxy.request(2, "tools/call", {
        name: "SearchMemories",
        arguments: { query: "sync engine", context: "looking it up" },
      });
      yield* proxy.request(3, "tools/call", {
        name: "Remember",
        arguments: { text: "x", repository: "reintersect/other", context: "storing it" },
      });
      yield* proxy.request(4, "tools/call", {
        name: "GetWorkspaces",
        arguments: { context: "checking" },
      });

      expect(server.calls.map((call) => call.arguments)).toEqual([
        { query: "sync engine", context: "looking it up", repository: "reintersect/app" },
        { text: "x", repository: "reintersect/other", context: "storing it" },
        { context: "checking" },
      ]);
    }),
  );

  it.scopedLive("omits the repository when the directory is not a git checkout", () =>
    Effect.gen(function* () {
      process.env.CLAUDE_PROJECT_DIR = tmpdir();

      const server = yield* backend(["SearchMemories"]);
      const proxy = yield* startProxy;

      yield* proxy.request(2, "tools/call", {
        name: "SearchMemories",
        arguments: { query: "x", context: "y" },
      });

      expect(server.calls[0]?.arguments).not.toHaveProperty("repository");
    }),
  );

  it.scopedLive("reports a backend failure as a tool error instead of crashing", () =>
    Effect.gen(function* () {
      const server = yield* Effect.promise(() =>
        startFakeBackend({ tools: ["SearchMemories"], onCall: () => ({}) }),
      );

      process.env.REINTERSECT_API_URL = server.url;

      const proxy = yield* startProxy;

      yield* Effect.promise(server.close);

      const reply = yield* proxy.request(2, "tools/call", {
        name: "SearchMemories",
        arguments: { context: "x" },
      });

      expect(reply.result?.isError).toBe(true);
    }),
  );
});

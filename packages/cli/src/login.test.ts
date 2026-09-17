import { createServer, type Server } from "node:http";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { awaitCallback, LoopbackServer, loopbackPort } from "#login";

const block = (port: number) =>
  Effect.acquireRelease(
    Effect.async<Server>((resume) => {
      const server = createServer();

      server.listen(port, "127.0.0.1", () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.async<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

const boundPort = loopbackPort.pipe(Effect.provide(LoopbackServer));

describe("loopback redirect ports", () => {
  it.scopedLive("falls through to the next fixed port when one is busy", () =>
    Effect.gen(function* () {
      yield* block(41893);

      expect(yield* boundPort).toBe(41894);
    }),
  );

  it.scopedLive("fails clearly when every fixed port is busy", () =>
    Effect.gen(function* () {
      yield* block(41893);
      yield* block(41894);
      yield* block(41895);

      const exit = yield* Effect.exit(boundPort);

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.scopedLive("resolves the callback query into a code", () =>
    Effect.gen(function* () {
      const callback = yield* awaitCallback;
      const port = yield* loopbackPort;

      yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/callback?code=abc&state=xyz`));

      expect(yield* Deferred.await(callback)).toMatchObject({ code: "abc", state: "xyz" });
    }).pipe(Effect.provide(LoopbackServer)),
  );
});

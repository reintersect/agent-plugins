import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Array, Console, Deferred, Effect, Layer, Schema } from "effect";
import { LOOPBACK_PORTS } from "#config";
import { LoginError } from "#errors";
import { authorizationUrl, discover, exchangeCode, pkce, register } from "#oauth";
import { AgentStore } from "#store";

const CallbackParams = Schema.Struct({
  code: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

type CallbackParams = typeof CallbackParams.Type;

const SUCCESS_PAGE =
  '<!doctype html><meta charset=utf-8><title>Reintersect</title><body style="font-family:system-ui;padding:3rem"><h1>Signed in</h1><p>You can close this tab and return to your terminal.</p>';

const serverOn = (port: number) => NodeHttpServer.layer(createServer, { host: "127.0.0.1", port });

const [firstPort, ...otherPorts] = LOOPBACK_PORTS;

export const LoopbackServer = Array.reduce(otherPorts, serverOn(firstPort), (layer, port) =>
  Layer.orElse(layer, () => serverOn(port)),
);

export const loopbackPort = HttpServer.addressWith((address) =>
  Effect.succeed(address._tag === "TcpAddress" ? address.port : 0),
);

export const awaitCallback = Effect.gen(function* () {
  const callback = yield* Deferred.make<CallbackParams>();

  const router = HttpRouter.empty.pipe(
    HttpRouter.get(
      "/callback",
      Effect.gen(function* () {
        const params = yield* HttpServerRequest.schemaSearchParams(CallbackParams);

        yield* Deferred.succeed(callback, params);

        return HttpServerResponse.html(SUCCESS_PAGE);
      }),
    ),
  );
  yield* HttpServer.serveEffect()(router);

  return callback;
});

const openBrowserDetached = (url: string) =>
  Effect.sync(() => {
    const [command, ...args] =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
    const child = spawn(command as string, args, { detached: true, stdio: "ignore" });

    child.on("error", () => undefined);
    child.unref();
  });

const callbackCode = (params: CallbackParams, expectedState: string) =>
  params.error !== undefined
    ? Effect.fail(new LoginError({ message: `authorization failed: ${params.error}` }))
    : params.code === undefined
      ? Effect.fail(new LoginError({ message: "authorization callback carried no code" }))
      : params.state !== expectedState
        ? Effect.fail(new LoginError({ message: "authorization callback state did not match" }))
        : Effect.succeed(params.code);

export const runLogin = (apiUrl: string) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;

    const server = yield* discover(apiUrl);
    const stored = yield* store.readAuth;
    const client =
      stored.apiUrl === apiUrl && stored.client !== undefined
        ? stored.client
        : yield* register(server);
    const callback = yield* awaitCallback;
    const port = yield* loopbackPort;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const { challenge, verifier } = yield* pkce;
    const state = randomUUID();
    const url = authorizationUrl({
      server,
      clientId: client.client_id,
      redirectUri,
      state,
      challenge,
    });

    yield* Console.log(`Open this URL to finish signing in:\n${url}`);
    yield* openBrowserDetached(url);

    const params = yield* Deferred.await(callback);
    const code = yield* callbackCode(params, state);
    const tokens = yield* exchangeCode({
      tokenEndpoint: server.token_endpoint,
      client,
      code,
      redirectUri,
      verifier,
    });

    yield* store.writeAuth({ apiUrl, tokenEndpoint: server.token_endpoint, client, tokens });
  });

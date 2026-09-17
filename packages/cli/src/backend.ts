import { McpSchema } from "@effect/ai";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import { Clock, Effect, Option, Redacted, Ref, Schema } from "effect";
import { ApiKey, ApiUrlOverride, CLIENT_NAME, CLIENT_VERSION, DEFAULT_API_URL } from "#config";
import { BackendCallError, NotAuthenticatedError } from "#errors";
import { refreshTokens } from "#oauth";
import type { AuthFile } from "#schema";
import { AgentStore } from "#store";

const PROTOCOL_VERSION = "2025-06-18";

const REFRESH_SKEW_MS = 60_000;

const NOT_SIGNED_IN = "not signed in: run the login command or set REINTERSECT_API_KEY";

const JsonRpcResponse = <A, I>(result: Schema.Schema<A, I>) =>
  Schema.Struct({ result: Schema.optional(result), error: Schema.optional(McpSchema.McpError) });

export class Backend extends Effect.Service<Backend>()("Backend", {
  effect: Effect.gen(function* () {
    const store = yield* AgentStore;
    const rawHttp = yield* HttpClient.HttpClient;
    const http = rawHttp.pipe(HttpClient.filterStatusOk);
    const override = yield* ApiUrlOverride;
    const apiKey = yield* ApiKey;
    const nextId = yield* Ref.make(0);
    const initialized = yield* Ref.make(Option.none<McpSchema.InitializeResult>());

    const apiUrl = store.readAuth.pipe(
      Effect.map((auth) => Option.getOrElse(override, () => auth.apiUrl ?? DEFAULT_API_URL)),
    );

    const freshTokens = (auth: AuthFile) =>
      Effect.gen(function* () {
        const tokens = yield* Option.fromNullable(auth.tokens).pipe(
          Effect.mapError(() => new NotAuthenticatedError({ message: NOT_SIGNED_IN })),
        );
        const now = yield* Clock.currentTimeMillis;
        const stale = tokens.expires_at !== undefined && tokens.expires_at - REFRESH_SKEW_MS <= now;

        if (!stale || auth.client === undefined || auth.tokenEndpoint === undefined) return tokens;

        const refreshed = yield* refreshTokens({
          tokenEndpoint: auth.tokenEndpoint,
          client: auth.client,
          tokens,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, rawHttp),
          Effect.mapError(
            () => new NotAuthenticatedError({ message: "token refresh failed; run login again" }),
          ),
        );

        yield* store.writeAuth({ ...auth, tokens: refreshed });

        return refreshed;
      });

    const bearer = Option.match(apiKey, {
      onSome: (key) => Effect.succeed(Redacted.value(key)),
      onNone: () =>
        store.readAuth.pipe(
          Effect.flatMap(freshTokens),
          Effect.map((tokens) => tokens.access_token),
        ),
    });

    const request = <A, I>(method: string, params: unknown, result: Schema.Schema<A, I>) =>
      Effect.gen(function* () {
        const token = yield* bearer;
        const url = yield* apiUrl;
        const id = yield* Ref.updateAndGet(nextId, (value) => value + 1);

        const body = yield* HttpClientRequest.post(`${url}/mcp`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
          HttpClientRequest.bodyJson({ jsonrpc: "2.0", id, method, params }),
        );
        const response = yield* http
          .execute(body)
          .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(JsonRpcResponse(result))));

        return yield* Option.match(Option.fromNullable(response.error), {
          onSome: (error) =>
            Effect.fail(new BackendCallError({ tool: method, message: error.message })),
          onNone: () =>
            Option.match(Option.fromNullable(response.result), {
              onNone: () =>
                Effect.fail(new BackendCallError({ tool: method, message: "empty response" })),
              onSome: Effect.succeed,
            }),
        });
      }).pipe(
        Effect.catchTags({
          ResponseError: (error) =>
            Effect.fail(
              error.response.status === 401
                ? new NotAuthenticatedError({ message: NOT_SIGNED_IN })
                : new BackendCallError({ tool: method, message: error.message }),
            ),
          RequestError: (error) =>
            Effect.fail(new BackendCallError({ tool: method, message: error.message })),
          HttpBodyError: (error) =>
            Effect.fail(new BackendCallError({ tool: method, message: String(error) })),
          ParseError: (error) =>
            Effect.fail(new BackendCallError({ tool: method, message: error.message })),
        }),
      );

    const initialize = Effect.gen(function* () {
      const current = yield* Ref.get(initialized);

      if (Option.isSome(current)) return current.value;

      const result = yield* request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
        },
        McpSchema.InitializeResult,
      );

      yield* Ref.set(initialized, Option.some(result));

      return result;
    });

    const serverInfo = Effect.map(initialize, (result) => result.serverInfo);

    const call = (name: string, args: Record<string, unknown>) =>
      request("tools/call", { name, arguments: args }, McpSchema.CallToolResult);

    const callTool = <A, I>(
      name: string,
      args: Record<string, unknown>,
      context: string,
      result: Schema.Schema<A, I>,
    ) =>
      call(name, { ...args, context }).pipe(
        Effect.flatMap((response) =>
          response.isError === true
            ? Effect.fail(
                new BackendCallError({ tool: name, message: JSON.stringify(response.content) }),
              )
            : Schema.decodeUnknown(result)(response.structuredContent).pipe(
                Effect.mapError(
                  (error) => new BackendCallError({ tool: name, message: error.message }),
                ),
              ),
        ),
      );

    const listTools = initialize.pipe(
      Effect.zipRight(request("tools/list", {}, McpSchema.ListToolsResult)),
      Effect.map((response) => response.tools),
    );

    return { apiUrl, call, callTool, initialize, listTools, serverInfo } as const;
  }),
  dependencies: [AgentStore.Default, NodeHttpClient.layerUndici],
}) {}

export const hasCredentials = Effect.gen(function* () {
  const store = yield* AgentStore;
  const apiKey = yield* ApiKey;

  const auth = yield* store.readAuth;

  return Option.isSome(apiKey) || auth.tokens !== undefined;
});

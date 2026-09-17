import { createHash, randomBytes } from "node:crypto";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Clock, Effect, Schema } from "effect";
import { CLIENT_NAME, REDIRECT_URIS } from "#config";
import { OAuthClient, type OAuthTokens } from "#schema";

export const AuthorizationServer = Schema.Struct({
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.String,
});

export type AuthorizationServer = typeof AuthorizationServer.Type;

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});

const SECOND_MS = 1_000;

const okClient = Effect.map(HttpClient.HttpClient, HttpClient.filterStatusOk);

export const discover = (apiUrl: string) =>
  okClient.pipe(
    Effect.flatMap((client) => client.get(`${apiUrl}/.well-known/oauth-authorization-server`)),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthorizationServer)),
  );

export const register = (server: AuthorizationServer) =>
  Effect.gen(function* () {
    const client = yield* okClient;

    const request = yield* HttpClientRequest.post(server.registration_endpoint).pipe(
      HttpClientRequest.bodyJson({
        client_name: CLIENT_NAME,
        redirect_uris: REDIRECT_URIS,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
    );

    return yield* client
      .execute(request)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(OAuthClient)));
  });

export const pkce = Effect.sync(() => {
  const verifier = randomBytes(32).toString("base64url");

  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
});

interface AuthorizationUrlOptions {
  readonly server: AuthorizationServer;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
}

export const authorizationUrl = (options: AuthorizationUrlOptions) => {
  const url = new URL(options.server.authorization_endpoint);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "openid offline_access");

  return url.toString();
};

interface TokenRequestOptions {
  readonly tokenEndpoint: string;
  readonly client: typeof OAuthClient.Type;
  readonly params: Record<string, string>;
}

const tokenRequest = ({ client, params, tokenEndpoint }: TokenRequestOptions) =>
  Effect.gen(function* () {
    const http = yield* okClient;
    const now = yield* Clock.currentTimeMillis;

    const response = yield* http.execute(
      HttpClientRequest.post(tokenEndpoint).pipe(
        HttpClientRequest.bodyUrlParams({
          ...params,
          client_id: client.client_id,
          ...(client.client_secret === undefined ? {} : { client_secret: client.client_secret }),
        }),
      ),
    );
    const token = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response);

    return {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: token.expires_in === undefined ? undefined : now + token.expires_in * SECOND_MS,
    } satisfies OAuthTokens;
  });

interface ExchangeCodeOptions {
  readonly tokenEndpoint: string;
  readonly client: typeof OAuthClient.Type;
  readonly code: string;
  readonly redirectUri: string;
  readonly verifier: string;
}

export const exchangeCode = ({
  client,
  code,
  redirectUri,
  tokenEndpoint,
  verifier,
}: ExchangeCodeOptions) =>
  tokenRequest({
    tokenEndpoint,
    client,
    params: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    },
  });

interface RefreshOptions {
  readonly tokenEndpoint: string;
  readonly client: typeof OAuthClient.Type;
  readonly tokens: OAuthTokens;
}

export const refreshTokens = ({ client, tokenEndpoint, tokens }: RefreshOptions) =>
  tokenRequest({
    tokenEndpoint,
    client,
    params: { grant_type: "refresh_token", refresh_token: tokens.refresh_token ?? "" },
  }).pipe(
    Effect.map((next) => ({ ...next, refresh_token: next.refresh_token ?? tokens.refresh_token })),
  );

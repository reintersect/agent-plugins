import { createHash } from "node:crypto";
import { Effect, Option, Redacted } from "effect";
import { ApiKey, ApiUrlOverride, DEFAULT_API_URL } from "#config";
import { AgentStore } from "#store";

export const currentCredentialKey = Effect.gen(function* () {
  const store = yield* AgentStore;
  const apiKey = yield* ApiKey;
  const override = yield* ApiUrlOverride;

  const auth = yield* store.readAuth;
  const apiUrl = Option.getOrElse(override, () => auth.apiUrl ?? DEFAULT_API_URL);
  const identity = Option.match(apiKey, {
    onSome: Redacted.value,
    onNone: () => auth.credentialId ?? auth.client?.client_id ?? "signed-out",
  });
  return createHash("sha256").update(`${apiUrl}\n${identity}`).digest("hex");
});

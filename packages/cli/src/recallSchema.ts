import { Schema } from "effect";

export const RecallTrigger = Schema.Literal(
  "startup",
  "prompt",
  "background",
  "compact",
  "resume",
  "subagent",
);

export type RecallTrigger = typeof RecallTrigger.Type;

export const RecallItem = Schema.Struct({
  key: Schema.String,
  revision: Schema.String,
  kind: Schema.Literal("profile", "fact"),
  text: Schema.String,
  memoryId: Schema.optional(Schema.String),
});

export type RecallItem = typeof RecallItem.Type;

export const RecallResult = Schema.Struct({
  context: Schema.String,
  memoryIds: Schema.Array(Schema.String),
  items: Schema.Array(RecallItem),
  invalidatedMemoryIds: Schema.Array(Schema.String),
  invalidatedProfileKeys: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  scopeKey: Schema.String,
  status: Schema.Literal("complete", "partial"),
});

export const RecallState = Schema.Struct({
  generation: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  taskVersion: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  scopeKey: Schema.optional(Schema.String),
  credentialKey: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  resetScopePending: Schema.optional(Schema.Boolean),
  lastAttempt: Schema.optional(Schema.Number),
  lastSuccess: Schema.optional(Schema.Number),
  lastEmission: Schema.optional(Schema.Number),
  lastTrigger: Schema.optional(RecallTrigger),
  durationMs: Schema.optional(Schema.Number),
  failures: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  failure: Schema.optional(
    Schema.Literal(
      "authentication",
      "timeout",
      "unavailable",
      "server_upgrade",
      "partial",
      "scope_changed",
    ),
  ),
  warned: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  emitted: Schema.optionalWith(Schema.Array(RecallItem), { default: () => [] }),
  lastContext: Schema.optional(Schema.String),
});

export type RecallState = typeof RecallState.Type;

export const EMPTY_RECALL_STATE: RecallState = {
  generation: 0,
  taskVersion: 0,
  failures: 0,
  warned: false,
  emitted: [],
};

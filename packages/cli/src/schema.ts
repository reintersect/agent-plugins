import { Schema } from "effect";

export const Host = Schema.Literal("claudeCode", "cursor", "codex", "opencode");

export type Host = typeof Host.Type;

const text = Schema.optional(Schema.NullOr(Schema.String));

export const MessageRecord = Schema.Struct({
  kind: Schema.Literal("person", "agent"),
  observedAt: Schema.String,
  text: Schema.String,
});

export const FileRecord = Schema.Struct({
  kind: Schema.Literal("file"),
  observedAt: Schema.String,
  action: Schema.Literal("read", "modified"),
  path: Schema.String,
});

export const CommandRecord = Schema.Struct({
  kind: Schema.Literal("command"),
  observedAt: Schema.String,
  command: Schema.String,
  failed: Schema.Boolean,
  category: Schema.Literal("test", "build", "shell"),
  output: Schema.optional(Schema.String),
});

export const CaptureRecord = Schema.Union(MessageRecord, FileRecord, CommandRecord);

export type CaptureRecord = typeof CaptureRecord.Type;

export type CommandRecord = typeof CommandRecord.Type;

export type FileRecord = typeof FileRecord.Type;

export const SessionState = Schema.Struct({
  host: Host,
  sessionId: Schema.String,
  repository: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  nextSeq: Schema.Number,
  flushedRecords: Schema.Number,
  exchanges: Schema.Number,
  pendingChars: Schema.Number,
  transcriptPath: Schema.optional(Schema.String),
  transcriptOffset: Schema.Number,
  skipTranscript: Schema.optional(Schema.Boolean),
  transcriptLeafUuid: Schema.optional(Schema.String),
  injectedMemoryIds: Schema.Array(Schema.String),
  firstPromptDone: Schema.Boolean,
  lastPromptText: Schema.optional(Schema.String),
  previousPromptText: Schema.optional(Schema.String),
  promptVersion: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  scopeKey: Schema.optional(Schema.String),
  apiUrl: Schema.optional(Schema.String),
  credentialKey: Schema.optional(Schema.String),
  scopeMismatch: Schema.optional(Schema.Boolean),
  scopeChanged: Schema.optional(Schema.Boolean),
  lastHookAt: Schema.optional(Schema.Number),
  lastUploadAt: Schema.optional(Schema.Number),
  lastFlushAt: Schema.optional(Schema.Number),
  pendingSince: Schema.optional(Schema.Number),
  queueWarned: Schema.optional(Schema.Boolean),
  heldRecords: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        credentialKey: Schema.String,
        promptVersion: Schema.Number,
        record: CaptureRecord,
      }),
    ),
    { default: () => [] },
  ),
  recentSignals: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
});

export type SessionState = typeof SessionState.Type;

export const IngestEvent = Schema.Struct({
  seq: Schema.Number,
  role: Schema.Literal("person", "agent", "evidence"),
  text: Schema.String,
  observedAt: Schema.String,
});

export type IngestEvent = typeof IngestEvent.Type;

export const Handoff = Schema.Struct({
  host: Host,
  sessionId: Schema.String,
  reason: Schema.String,
  snapshot: Schema.optional(
    Schema.Struct({
      events: Schema.Array(IngestEvent),
      throughRecord: Schema.Number,
      nextSeq: Schema.Number,
      repository: Schema.optional(Schema.String),
      branch: Schema.optional(Schema.String),
      scopeKey: Schema.optional(Schema.String),
      apiUrl: Schema.optional(Schema.String),
      credentialKey: Schema.optional(Schema.String),
    }),
  ),
});

export type Handoff = typeof Handoff.Type;

export const OAuthClient = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String),
});

export const OAuthTokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.Number),
});

export type OAuthTokens = typeof OAuthTokens.Type;

export const AuthFile = Schema.Struct({
  apiUrl: Schema.optional(Schema.String),
  credentialId: Schema.optional(Schema.String),
  tokenEndpoint: Schema.optional(Schema.String),
  client: Schema.optional(OAuthClient),
  tokens: Schema.optional(OAuthTokens),
});

export type AuthFile = typeof AuthFile.Type;

export const WorkspacesResult = Schema.Struct({
  workspaces: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.optionalWith(Schema.String, { default: () => "" }),
        current: Schema.optional(Schema.Boolean),
      }),
    ),
    { default: () => [] },
  ),
});

export const HookPayload = Schema.Struct({
  session_id: text,
  source: text,
  agent_id: text,
  turn_id: text,
  conversation_id: text,
  cwd: text,
  workspace_roots: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  transcript_path: text,
  prompt: text,
  tool_name: text,
  tool_use_id: text,
  tool_input: Schema.optional(Schema.Unknown),
  tool_response: Schema.optional(Schema.Unknown),
  tool_output: Schema.optional(Schema.Unknown),
  error_message: Schema.optional(Schema.Unknown),
  last_assistant_message: text,
  agent_type: text,
  command: text,
  output: Schema.optional(Schema.Unknown),
  file_path: text,
  text,
});

export type HookPayload = typeof HookPayload.Type;

export const ToolInput = Schema.Struct({
  command: text,
  cmd: text,
  message: text,
  file_path: text,
  filePath: text,
  path: text,
  notebook_path: text,
});

export const ToolResponse = Schema.Struct({
  output: Schema.optional(Schema.Unknown),
  aggregated_output: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.Unknown),
  stderr: Schema.optional(Schema.Unknown),
  error_message: Schema.optional(Schema.Unknown),
  exit_code: Schema.optional(Schema.Number),
  isError: Schema.optional(Schema.Boolean),
  success: Schema.optional(Schema.Boolean),
});

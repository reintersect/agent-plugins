import { Option, Schema } from "effect";
import { responseFailed } from "#capture";
import { HookPayload, type Host } from "#schema";

export type HookAction =
  | { readonly _tag: "SessionStart" }
  | { readonly _tag: "UserPrompt"; readonly prompt: string }
  | {
      readonly _tag: "Tool";
      readonly toolName: string;
      readonly toolInput: unknown;
      readonly toolResponse: unknown;
      readonly failed: boolean | undefined;
    }
  | { readonly _tag: "AssistantStop"; readonly text: string }
  | { readonly _tag: "SubagentStop"; readonly agentType: string; readonly text: string }
  | { readonly _tag: "Flush"; readonly reason: string }
  | { readonly _tag: "Ignore" };

export interface HookInput {
  readonly host: Host;
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath?: string;
  readonly toolUseId?: string;
  readonly action: HookAction;
}

type Mapper = (payload: HookPayload) => HookAction;

const IGNORE: HookAction = { _tag: "Ignore" };

const toolAction = (payload: HookPayload, failed?: boolean): HookAction => ({
  _tag: "Tool",
  toolName: payload.tool_name ?? "",
  toolInput: payload.tool_input,
  toolResponse: payload.tool_response ?? payload.tool_output ?? payload.error_message,
  failed: failed ?? responseFailed(payload.tool_response ?? payload.tool_output),
});

const CLAUDE_EVENTS: Record<string, Mapper> = {
  "session-start": () => ({ _tag: "SessionStart" }),
  "user-prompt": (payload) => ({ _tag: "UserPrompt", prompt: payload.prompt ?? "" }),
  "post-tool": (payload) => toolAction(payload),
  "post-tool-failure": (payload) => toolAction(payload, true),
  stop: (payload) => ({ _tag: "AssistantStop", text: payload.last_assistant_message ?? "" }),
  "subagent-stop": (payload) => ({
    _tag: "SubagentStop",
    agentType: payload.agent_type || "agent",
    text: payload.last_assistant_message ?? "",
  }),
  "pre-compact": () => ({ _tag: "Flush", reason: "pre-compact" }),
  "session-end": () => ({ _tag: "Flush", reason: "session-end" }),
};

const CURSOR_EVENTS: Record<string, Mapper> = {
  sessionStart: () => ({ _tag: "SessionStart" }),
  beforeSubmitPrompt: (payload) => ({ _tag: "UserPrompt", prompt: payload.prompt ?? "" }),
  postToolUse: (payload) => toolAction(payload),
  postToolUseFailure: (payload) => toolAction(payload, true),
  afterShellExecution: (payload) => ({
    _tag: "Tool",
    toolName: "Bash",
    toolInput: { command: payload.command ?? "" },
    toolResponse: payload.output,
    failed: responseFailed(payload.output) ?? responseFailed(payload),
  }),
  afterFileEdit: (payload) => ({
    _tag: "Tool",
    toolName: "Edit",
    toolInput: { file_path: payload.file_path ?? "" },
    toolResponse: undefined,
    failed: false,
  }),
  afterAgentResponse: (payload) => ({ _tag: "AssistantStop", text: payload.text ?? "" }),
  preCompact: () => ({ _tag: "Flush", reason: "pre-compact" }),
  sessionEnd: () => ({ _tag: "Flush", reason: "session-end" }),
};

const EVENTS: Record<Host, Record<string, Mapper>> = {
  claudeCode: CLAUDE_EVENTS,
  cursor: CURSOR_EVENTS,
  codex: CLAUDE_EVENTS,
  opencode: CLAUDE_EVENTS,
};

export const eventsFor = (host: Host) => Object.keys(EVENTS[host]);

export const resolveHost = (argument: Host, codexPluginRoot: Option.Option<string>): Host =>
  argument === "claudeCode" && Option.isSome(codexPluginRoot) ? "codex" : argument;

export interface HookFallbacks {
  readonly cwd: string;
  readonly transcriptPath: Option.Option<string>;
}

interface NormalizeOptions {
  readonly host: Host;
  readonly event: string;
  readonly raw: unknown;
  readonly fallbacks: HookFallbacks;
}

export const normalizeHookInput = ({
  event,
  fallbacks,
  host,
  raw,
}: NormalizeOptions): HookInput => {
  const payload = Option.getOrElse(
    Schema.decodeUnknownOption(HookPayload)(raw),
    (): HookPayload => ({}),
  );
  const cwd = payload.cwd || payload.workspace_roots?.[0] || fallbacks.cwd;
  const transcriptPath = payload.transcript_path || Option.getOrUndefined(fallbacks.transcriptPath);

  return {
    host,
    sessionId: payload.session_id || payload.conversation_id || "unknown-session",
    cwd,
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(payload.tool_use_id ? { toolUseId: payload.tool_use_id } : {}),
    action: (EVENTS[host][event] ?? (() => IGNORE))(payload),
  };
};

const CLAUDE_INJECTING_EVENTS: Record<string, string> = {
  "session-start": "SessionStart",
  "user-prompt": "UserPromptSubmit",
};

export const renderHookOutput = (host: Host, event: string, additionalContext: string) => {
  if (additionalContext.length === 0) return Option.none<string>();

  if (host === "cursor") {
    return event === "sessionStart"
      ? Option.some(JSON.stringify({ additional_context: additionalContext }))
      : Option.none<string>();
  }

  return Option.fromNullable(CLAUDE_INJECTING_EVENTS[event]).pipe(
    Option.map((hookEventName) =>
      JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }),
    ),
  );
};

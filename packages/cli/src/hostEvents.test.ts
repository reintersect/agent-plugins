import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { eventsFor, normalizeHookInput, renderHookOutput, resolveHost } from "#hostEvents";
import type { Host } from "#schema";

const fallbacks = { cwd: "/fallback", transcriptPath: Option.none<string>() };

const normalize = (host: Host, event: string, raw: unknown) =>
  normalizeHookInput({ host, event, raw, fallbacks });

const CLAUDE = {
  session_id: "cc-1",
  transcript_path: "/home/dev/.claude/cc-1.jsonl",
  cwd: "/repo",
};

describe("claude code payloads", () => {
  it.each([
    ["session-start", { source: "resume" }, { _tag: "SessionStart" }],
    [
      "user-prompt",
      { prompt: "Why does the build fail?" },
      { _tag: "UserPrompt", prompt: "Why does the build fail?" },
    ],
    [
      "post-tool",
      {
        tool_name: "Edit",
        tool_input: { file_path: "/repo/src/a.ts" },
        tool_response: { success: true },
      },
      { _tag: "Tool", toolName: "Edit", failed: false },
    ],
    [
      "post-tool-failure",
      { tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_response: "1 failing" },
      { _tag: "Tool", failed: true },
    ],
    ["stop", { last_assistant_message: "Fixed it." }, { _tag: "AssistantStop", text: "Fixed it." }],
    [
      "subagent-stop",
      { agent_type: "Explore", last_assistant_message: "Found three call sites." },
      { _tag: "SubagentStop", agentType: "Explore", text: "Found three call sites." },
    ],
    ["pre-compact", { trigger: "auto" }, { _tag: "Flush", reason: "pre-compact" }],
    ["session-end", { reason: "clear" }, { _tag: "Flush", reason: "session-end" }],
  ])("maps %s", (event, payload, action) => {
    expect(eventsFor("claudeCode")).toContain(event);
    expect(normalize("claudeCode", event, { ...CLAUDE, ...payload })).toMatchObject({
      sessionId: "cc-1",
      cwd: "/repo",
      transcriptPath: "/home/dev/.claude/cc-1.jsonl",
      action,
    });
  });

  it("writes hookSpecificOutput only for the injecting events", () => {
    expect(renderHookOutput("claudeCode", "session-start", "block")).toEqual(
      Option.some(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "block" },
        }),
      ),
    );
    expect(renderHookOutput("claudeCode", "user-prompt", "block")).toEqual(
      Option.some(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "block" },
        }),
      ),
    );
    expect(renderHookOutput("claudeCode", "stop", "block")).toEqual(Option.none());
    expect(renderHookOutput("claudeCode", "session-start", "")).toEqual(Option.none());
  });
});

describe("cursor payloads", () => {
  const CURSOR = { conversation_id: "cur-1", workspace_roots: ["/repo"], transcript_path: null };

  it("reads conversation id and workspace root", () => {
    expect(normalize("cursor", "sessionStart", CURSOR)).toMatchObject({
      sessionId: "cur-1",
      cwd: "/repo",
      action: { _tag: "SessionStart" },
    });
    expect(normalize("cursor", "sessionStart", {}).cwd).toBe("/fallback");
  });

  it("maps shell execution and file edits onto the shared tool shape", () => {
    expect(
      normalize("cursor", "afterShellExecution", {
        ...CURSOR,
        command: "pnpm test",
        output: { exit_code: 1, output: "failed" },
      }).action,
    ).toMatchObject({ _tag: "Tool", toolName: "Bash", failed: true });
    expect(
      normalize("cursor", "afterFileEdit", { ...CURSOR, file_path: "/repo/src/a.ts" }).action,
    ).toMatchObject({ _tag: "Tool", toolName: "Edit" });
    expect(
      normalize("cursor", "afterAgentResponse", { ...CURSOR, text: "Here is the summary." }).action,
    ).toEqual({ _tag: "AssistantStop", text: "Here is the summary." });
    expect(
      normalize("cursor", "postToolUseFailure", {
        ...CURSOR,
        tool_name: "Read",
        tool_input: { path: "/repo/missing.ts" },
        error_message: "no such file",
      }).action,
    ).toMatchObject({ _tag: "Tool", failed: true });
    expect(normalize("cursor", "sessionEnd", { ...CURSOR, reason: "closed" }).action).toEqual({
      _tag: "Flush",
      reason: "session-end",
    });
  });

  it("uses cursor's own output shape and stays quiet otherwise", () => {
    expect(renderHookOutput("cursor", "sessionStart", "block")).toEqual(
      Option.some(JSON.stringify({ additional_context: "block" })),
    );
    expect(renderHookOutput("cursor", "sessionStart", "")).toEqual(Option.none());
    expect(renderHookOutput("cursor", "beforeSubmitPrompt", "ignored")).toEqual(Option.none());
  });
});

describe("opencode payloads", () => {
  it("reuses the claude-shaped events and output", () => {
    expect(eventsFor("opencode")).toEqual(eventsFor("claudeCode"));
    expect(
      normalize("opencode", "post-tool", {
        session_id: "oc-1",
        cwd: "/repo",
        tool_name: "bash",
        tool_input: { command: "pnpm test" },
        tool_response: { output: "boom", exit_code: 1 },
      }).action,
    ).toMatchObject({ _tag: "Tool", toolName: "bash", failed: true });
    expect(renderHookOutput("opencode", "session-start", "block")).toEqual(
      Option.some(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "block" },
        }),
      ),
    );
  });
});

describe("codex detection", () => {
  it("treats the Claude Code plugin as Codex when Codex's PLUGIN_ROOT is set", () => {
    expect(resolveHost("claudeCode", Option.some("/plugins/reintersect"))).toBe("codex");
    expect(resolveHost("claudeCode", Option.none())).toBe("claudeCode");
    expect(resolveHost("cursor", Option.some("/x"))).toBe("cursor");
  });
});

describe("codex payloads", () => {
  it("derives failure from the shell response and uses the claude output shape", () => {
    expect(
      normalize("codex", "post-tool", {
        session_id: "cx-1",
        cwd: "/repo",
        tool_name: "shell",
        tool_input: { command: "pnpm build" },
        tool_response: { exit_code: 1, output: "boom" },
      }).action,
    ).toMatchObject({ _tag: "Tool", failed: true });
    expect(
      renderHookOutput("codex", "user-prompt", "block").pipe(Option.getOrElse(() => "")),
    ).toContain("UserPromptSubmit");
  });
});

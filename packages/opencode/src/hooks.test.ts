import { describe, expect, it } from "vitest";
import { type Deps, type Hooks, hooksFor } from "./hooks.ts";

interface Call {
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

const RECALL = "<reintersect_memory>\nFacts:\n- Zero owns reads. (id mem_1)\n</reintersect_memory>";

const makeHooks = () => {
  const calls: Call[] = [];
  const run: Deps["run"] = async (event, payload) => {
    calls.push({ event, payload });

    return event === "user-prompt" || event === "session-start" ? RECALL : undefined;
  };
  const client = {
    session: {
      messages: async () => ({
        data: [
          { info: { role: "user" }, parts: [{ type: "text", text: "Fix the build." }] },
          {
            info: { role: "assistant" },
            parts: [
              { type: "tool", tool: "bash" },
              { type: "text", text: "Done, the build passes." },
            ],
          },
        ],
      }),
    },
  } as unknown as Deps["client"];
  const hooks = hooksFor({
    run,
    client,
    directory: "/repo",
    packageDir: "/pkg",
    commands: [
      {
        name: "login",
        description: "Sign in",
        template: "Run {{PLUGIN_ROOT}}/dist/reintersect-agent.mjs login",
      },
    ],
  });

  return { hooks, calls };
};

const on = <K extends keyof Hooks>(hooks: Hooks, key: K) => {
  const hook = hooks[key];

  if (hook === undefined) throw new Error(`hook ${key} missing`);

  return hook;
};

const session = (id: string, parentID?: string) =>
  ({
    type: "session.created",
    properties: { info: { id, directory: "/repo", parentID } },
  }) as never;

describe("config", () => {
  it("adds the MCP server and commands without overriding the user's entries", async () => {
    const { hooks } = makeHooks();
    const config = {
      mcp: { reintersect: { type: "remote" as const, url: "https://example.test/mcp" } },
      command: { "reintersect-login": { template: "mine" } },
    };

    await on(hooks, "config")(config as never);

    expect(config.mcp.reintersect).toEqual({ type: "remote", url: "https://example.test/mcp" });
    expect(config.command["reintersect-login"]).toEqual({ template: "mine" });

    const fresh: { mcp?: Record<string, unknown>; command?: Record<string, unknown> } = {};

    await on(hooks, "config")(fresh as never);

    expect(fresh.mcp?.reintersect).toEqual({
      type: "local",
      command: ["node", "/pkg/dist/reintersect-agent.mjs", "mcp"],
      enabled: true,
    });
    expect(fresh.command?.["reintersect-login"]).toEqual({
      description: "Sign in",
      template: "Run /pkg/dist/reintersect-agent.mjs login",
    });
  });
});

describe("session lifecycle", () => {
  it("recalls at session start and on the first prompt, then feeds both blocks to the system prompt", async () => {
    const { hooks, calls } = makeHooks();

    await on(hooks, "event")({ event: session("s1") });
    await on(hooks, "chat.message")({ sessionID: "s1" } as never, {
      message: {} as never,
      parts: [
        { type: "text", text: "Why does the dashboard read through Zero?" },
        { type: "text", text: "ignored", synthetic: true },
      ] as never,
    });

    expect(calls).toEqual([
      { event: "session-start", payload: { session_id: "s1", cwd: "/repo" } },
      {
        event: "user-prompt",
        payload: {
          session_id: "s1",
          cwd: "/repo",
          prompt: "Why does the dashboard read through Zero?",
        },
      },
    ]);

    const output = { system: ["base prompt"] };

    await on(hooks, "experimental.chat.system.transform")({ sessionID: "s1" } as never, output);
    expect(output.system).toEqual(["base prompt", RECALL, RECALL]);

    const untouched = { system: ["base prompt"] };

    await on(hooks, "experimental.chat.system.transform")({} as never, untouched);
    expect(untouched.system).toEqual(["base prompt"]);
  });

  it("ignores subagent sessions", async () => {
    const { hooks, calls } = makeHooks();

    await on(hooks, "event")({ event: session("child", "parent") });
    await on(hooks, "chat.message")({ sessionID: "child" } as never, {
      message: {} as never,
      parts: [{ type: "text", text: "subagent prompt" }] as never,
    });
    await on(hooks, "tool.execute.after")(
      { tool: "bash", sessionID: "child", callID: "c", args: { command: "ls" } },
      { title: "ls", output: "", metadata: { exit: 0 } },
    );

    expect(calls).toEqual([]);
  });

  it("captures the reply at idle and flushes on compaction, deletion and dispose", async () => {
    const { hooks, calls } = makeHooks();

    await on(hooks, "event")({ event: session("s1") });
    await on(
      hooks,
      "event",
    )({ event: { type: "session.idle", properties: { sessionID: "s1" } } as never });
    await on(hooks, "experimental.session.compacting")({ sessionID: "s1" }, { context: [] });
    await on(hooks, "event")({ event: session("s2") });
    await on(hooks, "dispose")();
    await on(
      hooks,
      "event",
    )({
      event: { type: "session.deleted", properties: { info: { id: "s1" } } } as never,
    });

    expect(calls.slice(1).map((call) => [call.event, call.payload])).toEqual([
      [
        "stop",
        { session_id: "s1", cwd: "/repo", last_assistant_message: "Done, the build passes." },
      ],
      ["pre-compact", { session_id: "s1", cwd: "/repo" }],
      ["session-start", { session_id: "s2", cwd: "/repo" }],
      ["session-end", { session_id: "s1", cwd: "/repo" }],
      ["session-end", { session_id: "s2", cwd: "/repo" }],
    ]);
  });
});

describe("ordering", () => {
  it("runs the hooks of one session one at a time, in arrival order", async () => {
    const order: string[] = [];
    const run: Deps["run"] = async (event) => {
      order.push(`start ${event}`);
      await new Promise((resolve) => setTimeout(resolve, event === "session-start" ? 30 : 1));
      order.push(`end ${event}`);

      return undefined;
    };
    const hooks = hooksFor({
      run,
      client: {} as Deps["client"],
      directory: "/repo",
      packageDir: "/pkg",
      commands: [],
    });

    await Promise.all([
      on(hooks, "event")({ event: session("s1") }),
      on(hooks, "chat.message")({ sessionID: "s1" } as never, {
        message: {} as never,
        parts: [{ type: "text", text: "hello there, long enough" }] as never,
      }),
    ]);

    expect(order).toEqual([
      "start session-start",
      "end session-start",
      "start user-prompt",
      "end user-prompt",
    ]);
  });
});

describe("tools", () => {
  it("maps shell and edit tools onto post-tool and task onto subagent-stop", async () => {
    const { hooks, calls } = makeHooks();

    await on(hooks, "tool.execute.after")(
      { tool: "bash", sessionID: "s1", callID: "c1", args: { command: "pnpm test" } },
      { title: "pnpm test", output: "1 failing", metadata: { exit: 1 } },
    );
    await on(hooks, "tool.execute.after")(
      { tool: "edit", sessionID: "s1", callID: "c2", args: { filePath: "/repo/src/a.ts" } },
      { title: "edit", output: "ok", metadata: {} },
    );
    await on(hooks, "tool.execute.after")(
      {
        tool: "task",
        sessionID: "s1",
        callID: "c3",
        args: { subagent_type: "explore", description: "find it", prompt: "Where?" },
      },
      { title: "task", output: "Found it in src/a.ts.", metadata: {} },
    );

    expect(calls.map((call) => [call.event, call.payload])).toEqual([
      [
        "post-tool",
        {
          session_id: "s1",
          cwd: "/repo",
          tool_name: "bash",
          tool_input: { command: "pnpm test" },
          tool_response: { output: "1 failing", exit_code: 1 },
        },
      ],
      [
        "post-tool",
        {
          session_id: "s1",
          cwd: "/repo",
          tool_name: "edit",
          tool_input: { filePath: "/repo/src/a.ts" },
          tool_response: { output: "ok" },
        },
      ],
      [
        "subagent-stop",
        {
          session_id: "s1",
          cwd: "/repo",
          agent_type: "explore",
          last_assistant_message: "Found it in src/a.ts.",
        },
      ],
    ]);
  });
});

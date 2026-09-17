import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";

export type { Hooks };

const HOST = "opencode";

const HOOK_TIMEOUT_MS = 6_000;

export const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const BUNDLE = join(PACKAGE_DIR, "dist", "reintersect-agent.mjs");

type Payload = Record<string, unknown>;

export type Runner = (event: string, payload: Payload) => Promise<string | undefined>;

export interface CommandTemplate {
  readonly name: string;
  readonly description: string;
  readonly template: string;
}

export interface Deps {
  readonly run: Runner;
  readonly directory: string;
  readonly client: PluginInput["client"];
  readonly commands: ReadonlyArray<CommandTemplate>;
  readonly packageDir: string;
}

const additionalContext = (stdout: string) => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const output =
      typeof parsed === "object" && parsed !== null && "hookSpecificOutput" in parsed
        ? parsed.hookSpecificOutput
        : undefined;
    const context =
      typeof output === "object" && output !== null && "additionalContext" in output
        ? output.additionalContext
        : undefined;

    return typeof context === "string" && context.length > 0 ? context : undefined;
  } catch {
    return undefined;
  }
};

export const spawnHook: Runner = (event, payload) =>
  new Promise((resolve) => {
    const child = spawn("node", [BUNDLE, "hook", HOST, event], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), HOOK_TIMEOUT_MS);
    const finish = (value: string | undefined) => {
      clearTimeout(timer);
      resolve(value);
    };

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(additionalContext(Buffer.concat(chunks).toString("utf8"))));
    child.stdin.end(JSON.stringify(payload));
  });

export const loadCommands = (): ReadonlyArray<CommandTemplate> => {
  try {
    return JSON.parse(
      readFileSync(join(PACKAGE_DIR, "dist", "commands.json"), "utf8"),
    ) as CommandTemplate[];
  } catch {
    return [];
  }
};

const textOf = (parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }>) =>
  parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && part.text ? [part.text] : []))
    .join("\n");

const lastAssistantText = async (client: PluginInput["client"], sessionID: string) => {
  const response = await client.session.messages({ path: { id: sessionID } });
  const messages = response.data ?? [];
  const last = [...messages].reverse().find((message) => message.info.role === "assistant");

  return last === undefined ? "" : textOf(last.parts);
};

const serialize = (run: Runner): Runner => {
  const queues = new Map<string, Promise<unknown>>();

  return (event, payload) => {
    const key = typeof payload.session_id === "string" ? payload.session_id : "";
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(
      () => run(event, payload),
      () => run(event, payload),
    );

    queues.set(key, next);

    return next;
  };
};

export const hooksFor = ({
  client,
  commands,
  directory,
  packageDir,
  run: unordered,
}: Deps): Hooks => {
  const run = serialize(unordered);
  const context = new Map<string, string[]>();
  const sessions = new Set<string>();
  const children = new Set<string>();
  const base = (sessionID: string) => ({ session_id: sessionID, cwd: directory });
  const remember = (sessionID: string, block: string | undefined) => {
    if (block !== undefined) context.set(sessionID, [...(context.get(sessionID) ?? []), block]);
  };
  const bundle = join(packageDir, "dist", "reintersect-agent.mjs");

  return {
    config: async (config) => {
      config.mcp = {
        reintersect: { type: "local", command: ["node", bundle, "mcp"], enabled: true },
        ...config.mcp,
      };
      config.command = {
        ...Object.fromEntries(
          commands.map((command) => [
            `reintersect-${command.name}`,
            {
              description: command.description,
              template: command.template.replaceAll("{{PLUGIN_ROOT}}", packageDir),
            },
          ]),
        ),
        ...config.command,
      };
    },
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = event.properties.info;

        if (info.parentID !== undefined) {
          children.add(info.id);
          return;
        }

        sessions.add(info.id);
        remember(info.id, await run("session-start", { session_id: info.id, cwd: info.directory }));
      }
      if (event.type === "session.idle" && sessions.has(event.properties.sessionID)) {
        const sessionID = event.properties.sessionID;
        const text = await lastAssistantText(client, sessionID).catch(() => "");

        await run("stop", { ...base(sessionID), last_assistant_message: text });
      }
      if (event.type === "session.deleted" && sessions.delete(event.properties.info.id)) {
        await run("session-end", base(event.properties.info.id));
      }
    },
    "chat.message": async ({ sessionID }, { parts }) => {
      if (children.has(sessionID)) return;

      sessions.add(sessionID);
      remember(sessionID, await run("user-prompt", { ...base(sessionID), prompt: textOf(parts) }));
    },
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      const blocks = sessionID === undefined ? undefined : context.get(sessionID);

      if (blocks !== undefined) output.system.push(...blocks);
    },
    "tool.execute.after": async ({ args, sessionID, tool }, { metadata, output }) => {
      if (children.has(sessionID)) return;

      const input: Payload = typeof args === "object" && args !== null ? args : {};

      if (tool === "task") {
        await run("subagent-stop", {
          ...base(sessionID),
          agent_type: typeof input.subagent_type === "string" ? input.subagent_type : "agent",
          last_assistant_message: output,
        });
        return;
      }

      const exit: unknown =
        typeof metadata === "object" && metadata !== null && "exit" in metadata
          ? metadata.exit
          : undefined;

      await run("post-tool", {
        ...base(sessionID),
        tool_name: tool,
        tool_input: input,
        tool_response: { output, ...(typeof exit === "number" ? { exit_code: exit } : {}) },
      });
    },
    "experimental.session.compacting": async ({ sessionID }) => {
      await run("pre-compact", base(sessionID));
    },
    dispose: async () => {
      await Promise.all([...sessions].map((sessionID) => run("session-end", base(sessionID))));
      sessions.clear();
    },
  };
};

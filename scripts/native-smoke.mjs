import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRepo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "rei-native-"));
const project = join(root, "project");
mkdirSync(project);
const requests = [];
const calls = [];
const toolState = { claude: 0, codex: 0 };
const allowBackgroundRefresh = (host) => {
  const directory = join(root, `${host}-agent`, "recall");
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, lastAttempt: Date.now() - 61000 }));
  }
};
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (req.url === "/mcp") {
    if (body.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const reply = (result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    };
    if (body.method === "initialize")
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      });
    if (body.method === "tools/list") return reply({ tools: [] });
    if (body.method === "tools/call") {
      calls.push(body.params);
      const beta = String(body.params.arguments.prompt).includes("beta");
      const background = body.params.arguments.trigger === "background";
      const marker = background
        ? "MEMORY_BACKGROUND_920"
        : beta
          ? "MEMORY_BETA_739"
          : "MEMORY_ALPHA_418";
      const value =
        body.params.name === "RecallForCodingSession"
          ? {
              context: marker,
              memoryIds: ["fixture-memory"],
              items: [
                {
                  key: "fixture-memory",
                  memoryId: "fixture-memory",
                  kind: "fact",
                  revision: background ? "3" : beta ? "2" : "1",
                  text: marker,
                },
              ],
              invalidatedMemoryIds: [],
              invalidatedProfileKeys: [],
              scopeKey: "fixture-org:fixture-member",
              status: "complete",
            }
          : { sessionId: "fixture-server-session" };
      return reply({
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: value,
      });
    }
    return reply({});
  }
  if (!req.url?.includes("/messages") && !req.url?.includes("/responses")) {
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    return;
  }
  requests.push({ path: req.url, body });
  const send = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  if (req.url?.includes("/messages")) {
    const serialized = JSON.stringify(body.messages);
    const native = serialized.includes("native-tools");
    const hasResult = serialized.includes('"tool_result"');
    const tool =
      native && toolState.claude === 0
        ? {
            name: "Agent",
            input: {
              description: "synthetic child",
              subagent_type: "general-purpose",
              prompt: "child-only fixture: return one line.",
            },
          }
        : native && hasResult && toolState.claude >= 1 && toolState.claude < 3
          ? {
              name: "Bash",
              input: {
                command: "printf 'fixture native command\\n'",
                description: "Print synthetic fixture output",
              },
            }
          : undefined;
    if (tool) {
      if (toolState.claude === 1) allowBackgroundRefresh("claude");
      if (toolState.claude === 2) await new Promise((resolve) => setTimeout(resolve, 700));
      toolState.claude += 1;
      send("message_start", {
        type: "message_start",
        message: {
          id: `msg_tool_${toolState.claude}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: `tool_fixture_${toolState.claude}`,
          name: tool.name,
          input: {},
        },
      });
      send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
      });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 10 },
      });
      send("message_stop", { type: "message_stop" });
      res.end();
      return;
    }
    send("message_start", {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Fixture completed." },
    });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    });
    send("message_stop", { type: "message_stop" });
  } else {
    const id = `resp_${randomUUID()}`;
    const toolCall =
      JSON.stringify(body.input ?? []).includes("native-tools") && toolState.codex < 2;
    const item = toolCall
      ? {
          id: "fc_fixture",
          type: "function_call",
          name: "exec_command",
          call_id: "call_fixture",
          arguments: JSON.stringify({
            cmd: "printf 'fixture native command\\n'",
            yield_time_ms: 1000,
          }),
        }
      : {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Fixture completed.", annotations: [] }],
        };
    const response = {
      id,
      object: "response",
      created_at: 1,
      model: body.model,
      status: "completed",
      output: [item],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    };
    send("response.created", {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    });
    if (toolCall) {
      if (toolState.codex === 0) allowBackgroundRefresh("codex");
      if (toolState.codex === 1) await new Promise((resolve) => setTimeout(resolve, 700));
      toolState.codex += 1;
      send("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, arguments: "" },
      });
      send("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: item.id,
        delta: item.arguments,
      });
      send("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: item.id,
        arguments: item.arguments,
      });
      send("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item,
      });
      send("response.completed", { type: "response.completed", response });
      res.end();
      return;
    }
    send("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    });
    send("response.content_part.added", {
      type: "response.content_part.added",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    send("response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: "Fixture completed.",
    });
    send("response.output_text.done", {
      type: "response.output_text.done",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      text: "Fixture completed.",
    });
    send("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
    send("response.completed", { type: "response.completed", response });
  }
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const baseEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: "en_US.UTF-8",
  REINTERSECT_API_KEY: "rei_synthetic_fixture",
  REINTERSECT_API_URL: url,
  DO_NOT_TRACK: "1",
};
const run = (bin, args, env, label) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: project,
      env: { ...baseEnv, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    child.stdout.on("data", (value) => output.push(value));
    child.stderr.on("data", (value) => output.push(value));
    const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(output).toString();
      writeFileSync(join(root, `${label}.log`), text);
      console.log(
        JSON.stringify({
          label,
          code,
          modelRequests: requests.length,
          recallCalls: calls.filter((call) => call.name === "RecallForCodingSession").length,
        }),
      );
      code === 0 ? resolve(text) : reject(new Error(`${label} exit ${code}: ${text.slice(-1800)}`));
    });
  });
try {
  await run("git", ["init", "-q", "-b", "main"], {}, "git");
  const claudeConfig = join(root, "claude-config");
  mkdirSync(claudeConfig);
  const claudeEnv = {
    CLAUDE_CONFIG_DIR: claudeConfig,
    ANTHROPIC_API_KEY: "synthetic-fixture",
    ANTHROPIC_BASE_URL: url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    REINTERSECT_AGENT_HOME: join(root, "claude-agent"),
  };
  const session = randomUUID();
  const claudeArgs = [
    "-p",
    "--model",
    "claude-sonnet-4-6",
    "--plugin-dir",
    join(pluginRepo, "plugins/claude-code"),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
  ];
  await run(
    "claude",
    [...claudeArgs, "--session-id", session, "alpha fixture prompt"],
    claudeEnv,
    "claude-alpha",
  );
  await run(
    "claude",
    [...claudeArgs, "--resume", session, "beta fixture prompt"],
    claudeEnv,
    "claude-beta",
  );
  await run(
    "claude",
    [...claudeArgs, "--resume", session, "/compact"],
    claudeEnv,
    "claude-compact",
  );
  await run(
    "claude",
    [...claudeArgs, "--resume", session, "beta fixture after compaction"],
    claudeEnv,
    "claude-after-compact",
  );
  await run(
    "claude",
    [
      ...claudeArgs,
      "--allowedTools",
      "Agent",
      "Bash(printf *)",
      "--",
      "native-tools fixture prompt",
    ],
    claudeEnv,
    "claude-tools",
  );
  const codexHome = join(root, "codex-config");
  mkdirSync(codexHome);
  const codexEnv = { CODEX_HOME: codexHome, REINTERSECT_AGENT_HOME: join(root, "codex-agent") };
  writeFileSync(
    join(codexHome, "config.toml"),
    `model = "gpt-5.4"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "${url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`,
  );
  await run(
    "codex",
    ["plugin", "marketplace", "add", pluginRepo, "--json"],
    codexEnv,
    "codex-marketplace",
  );
  await run(
    "codex",
    ["plugin", "add", "reintersect@reintersect", "--json"],
    codexEnv,
    "codex-install",
  );
  await run(
    "codex",
    [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-hook-trust",
      "alpha fixture prompt",
    ],
    codexEnv,
    "codex-alpha",
  );
  await run(
    "codex",
    [
      "exec",
      "resume",
      "--last",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-hook-trust",
      "beta fixture prompt",
    ],
    codexEnv,
    "codex-beta",
  );
  await run(
    "codex",
    [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-hook-trust",
      "native-tools fixture prompt",
    ],
    codexEnv,
    "codex-tools",
  );
  writeFileSync(join(root, "evidence.json"), JSON.stringify({ requests, calls }, null, 2));
  assert(
    requests.some(
      (request) =>
        request.path?.includes("/messages") &&
        JSON.stringify(request.body).includes("MEMORY_ALPHA_418"),
    ),
  );
  assert(
    requests.some(
      (request) =>
        request.path?.includes("/messages") &&
        JSON.stringify(request.body).includes("MEMORY_BETA_739"),
    ),
  );
  assert(
    requests.some(
      (request) =>
        request.path?.includes("/responses") &&
        JSON.stringify(request.body).includes("MEMORY_ALPHA_418"),
    ),
  );
  assert(
    requests.some(
      (request) =>
        request.path?.includes("/responses") &&
        JSON.stringify(request.body).includes("MEMORY_BETA_739"),
    ),
  );
  assert(
    calls.some(
      (call) => call.name === "RecallForCodingSession" && call.arguments.trigger === "subagent",
    ),
  );
  assert(
    calls.some(
      (call) => call.name === "RecallForCodingSession" && call.arguments.trigger === "compact",
    ),
  );
  for (const host of ["claude", "codex"]) {
    const directory = join(root, `${host}-agent`, "sessions");
    const records = readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) =>
        readFileSync(join(directory, name), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
    assert(records.some((record) => record.kind === "command" && record.failed === false));
  }
  for (const host of ["claudeCode", "codex"])
    assert(
      calls.some(
        (call) =>
          call.name === "RecallForCodingSession" &&
          call.arguments.trigger === "background" &&
          call.arguments.host === host,
      ),
    );
  for (const route of ["/messages", "/responses"])
    assert(
      requests.some(
        (request) =>
          request.path?.includes(route) &&
          JSON.stringify(request.body).includes("MEMORY_BACKGROUND_920"),
      ),
    );
  console.log(`PASS native memory delivery; evidence ${root}`);
} finally {
  server.closeAllConnections();
  server.close();
  console.log(`Artifacts ${root}`);
}

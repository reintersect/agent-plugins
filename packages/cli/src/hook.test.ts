import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { setPaused } from "#commands";
import { runFlush } from "#flush";
import { runHook } from "#hook";
import { type FakeBackendOptions, fakeBackend } from "#testing/fakeBackend";
import { app, makeAgentHome, makeGitRepo } from "#testing/harness";

const ALL_TOOLS = ["RecallForCodingSession", "IngestCodingSession", "SearchMemories"];

const RECALL_BLOCK = [
  "<reintersect_memory>",
  "Use this as if you already knew it; never say it was retrieved. Facts record what was true when written.",
  "Facts:",
  "- Zero owns dashboard reads. (decision, repository, 12 May 2026, id mem_1)",
  "</reintersect_memory>",
].join("\n");

const state = { home: "", repo: "" };

const claude = (event: string, extra: Record<string, unknown>) =>
  app(
    runHook("claudeCode", event, JSON.stringify({ session_id: "s-1", cwd: state.repo, ...extra })),
  );

const sessionLog = () =>
  readFileSync(
    join(state.home, "sessions", readdirSync(join(state.home, "sessions"))[0] as string),
    "utf8",
  );

const pendingFiles = () => readdirSync(join(state.home, "pending"));

const pendingPath = (reason: string) =>
  join(state.home, "pending", pendingFiles().find((name) => name.includes(reason)) as string);

const backend = (options: { tools?: FakeBackendOptions["tools"]; recall?: unknown } = {}) =>
  fakeBackend({
    tools: options.tools ?? ALL_TOOLS,
    onCall: (call) =>
      call.name === "RecallForCodingSession"
        ? (options.recall ?? { context: RECALL_BLOCK, memoryIds: ["mem_1"] })
        : { sessionId: "srv-1" },
  });

beforeEach(() => {
  state.home = makeAgentHome();
  state.repo = makeGitRepo();
  process.env.REINTERSECT_API_KEY = "rei_testkeyvalue";
});

afterEach(() => {
  delete process.env.REINTERSECT_API_URL;
  delete process.env.REINTERSECT_API_KEY;
});

describe("session lifecycle", () => {
  it.scopedLive("recalls at session start and injects the block Claude Code understands", () =>
    Effect.gen(function* () {
      const server = yield* backend();

      const output = yield* claude("session-start", { source: "startup" });

      expect(JSON.parse(Option.getOrElse(output, () => "{}"))).toEqual({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: RECALL_BLOCK },
      });
      expect(server.calls[0]?.name).toBe("RecallForCodingSession");
      expect(server.calls[0]?.arguments).toMatchObject({
        repository: "reintersect/app",
        branch: "main",
        host: "claudeCode",
      });
      expect(server.calls[0]?.arguments.context).toBeTypeOf("string");
    }),
  );

  it.scopedLive("recalls once more on the first long prompt and hides memories already shown", () =>
    Effect.gen(function* () {
      const server = yield* backend();

      yield* claude("session-start", { source: "startup" });

      const output = yield* claude("user-prompt", {
        prompt: "Why does the dashboard read through Zero instead of REST?",
      });

      expect(output).toEqual(Option.none());
      expect(server.calls.filter((call) => call.name === "RecallForCodingSession")).toHaveLength(2);
    }),
  );

  it.scopedLive("skips recall for a prompt shorter than twenty characters", () =>
    Effect.gen(function* () {
      const server = yield* backend();

      yield* claude("user-prompt", { prompt: "fix it" });

      expect(server.calls).toHaveLength(0);
      expect(sessionLog()).toContain("fix it");
    }),
  );

  it.scopedLive("never fails the host when the backend is unreachable", () =>
    Effect.gen(function* () {
      process.env.REINTERSECT_API_URL = "http://127.0.0.1:1";

      const output = yield* claude("session-start", { source: "startup" });

      expect(output).toEqual(Option.none());
      expect(readFileSync(join(state.home, "errors.log"), "utf8")).toContain("recall");
    }),
  );

  it.scopedLive("captures nothing at all while paused", () =>
    Effect.gen(function* () {
      const server = yield* backend();

      yield* claude("session-start", { source: "startup" });
      yield* app(setPaused(true));
      yield* claude("user-prompt", { prompt: "A private question about salaries" });

      expect(sessionLog()).not.toContain("salaries");
      expect(server.calls.filter((call) => call.name === "RecallForCodingSession")).toHaveLength(1);
    }),
  );
});

describe("capture and flush", () => {
  it.scopedLive("ships prompts, agent text and rendered evidence to IngestCodingSession", () =>
    Effect.gen(function* () {
      const server = yield* backend();

      yield* claude("session-start", { source: "startup" });
      yield* claude("user-prompt", { prompt: "Make the dashboard read through Zero." });
      yield* claude("post-tool", {
        tool_name: "Edit",
        tool_input: { file_path: join(state.repo, "src/app.ts") },
        tool_response: { success: true },
      });
      yield* claude("post-tool-failure", {
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
        tool_response: "1 failing",
      });
      yield* claude("stop", { last_assistant_message: "Rewired it to Zero." });
      yield* claude("session-end", { reason: "clear" });
      yield* app(runFlush(pendingPath("session-end")));

      const ingest = server.calls.find((call) => call.name === "IngestCodingSession");
      const events = ingest?.arguments.events as Array<{ seq: number; role: string; text: string }>;

      expect(ingest?.arguments).toMatchObject({
        host: "claudeCode",
        hostSessionId: "s-1",
        repository: "reintersect/app",
        branch: "main",
      });
      expect(events.map((event) => [event.seq, event.role])).toEqual([
        [0, "person"],
        [1, "agent"],
        [2, "evidence"],
      ]);
      expect(events[0]?.text).toBe("Make the dashboard read through Zero.");
      expect(events[2]?.text).toContain("Files modified:\n- src/app.ts");
      expect(events[2]?.text).toContain("`pnpm test` (test) failed");
      expect(events[2]?.text).toContain("1 failing");
      expect(pendingFiles().some((name) => name.includes("session-end"))).toBe(false);
    }),
  );

  it.scopedLive(
    "captures the active transcript branch at Stop without duplicating the prompt",
    () =>
      Effect.gen(function* () {
        const server = yield* backend();
        const transcript = join(state.home, "transcript.jsonl");
        const rows = [
          {
            uuid: "u1",
            parentUuid: null,
            sessionId: "s-1",
            type: "user",
            message: { role: "user", content: "Please fix the failing build." },
          },
          {
            uuid: "u2",
            parentUuid: "u1",
            sessionId: "s-1",
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Checking the tsconfig." }],
            },
          },
          {
            uuid: "u3",
            parentUuid: "u2",
            sessionId: "s-1",
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Fixed the tsconfig." }],
            },
          },
        ];

        writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        yield* claude("user-prompt", { prompt: "Please fix the failing build." });
        yield* claude("stop", {
          transcript_path: transcript,
          last_assistant_message: "Fixed the tsconfig.",
        });
        yield* claude("session-end", { reason: "clear" });
        yield* app(runFlush(pendingPath("session-end")));

        const ingest = server.calls.find((call) => call.name === "IngestCodingSession");
        const events = ingest?.arguments.events as Array<{ role: string; text: string }>;

        expect(events.map((event) => [event.role, event.text])).toEqual([
          ["person", "Please fix the failing build."],
          ["agent", "Checking the tsconfig."],
          ["agent", "Fixed the tsconfig."],
        ]);
      }),
  );

  it.scopedLive("does not resend what the previous flush already accepted", () =>
    Effect.gen(function* () {
      const server = yield* backend();

      yield* claude("session-start", { source: "startup" });
      yield* claude("user-prompt", { prompt: "First long enough question here." });
      yield* claude("stop", { last_assistant_message: "First answer." });
      yield* claude("pre-compact", { trigger: "auto" });
      yield* app(runFlush(pendingPath("pre-compact")));
      yield* claude("user-prompt", { prompt: "Second question, also long." });
      yield* claude("stop", { last_assistant_message: "Second answer." });
      yield* claude("session-end", { reason: "clear" });
      yield* app(runFlush(pendingPath("session-end")));

      const ingests = server.calls.filter((call) => call.name === "IngestCodingSession");
      const seqs = ingests.map((call) =>
        (call.arguments.events as Array<{ seq: number }>).map((event) => event.seq),
      );

      expect(seqs).toEqual([
        [0, 1],
        [2, 3],
      ]);
    }),
  );

  it.scopedLive("keeps the batch pending when the ingest tool is missing", () =>
    Effect.gen(function* () {
      const server = yield* backend({ tools: ["RecallForCodingSession"] });

      yield* claude("user-prompt", { prompt: "A question long enough to record." });
      yield* claude("session-end", { reason: "clear" });
      yield* app(runFlush(pendingPath("session-end")));

      expect(pendingFiles().filter((name) => name.endsWith(".json"))).toHaveLength(1);
      expect(server.calls.some((call) => call.name === "IngestCodingSession")).toBe(false);
      expect(readFileSync(join(state.home, "errors.log"), "utf8")).toContain("flush");
    }),
  );
});

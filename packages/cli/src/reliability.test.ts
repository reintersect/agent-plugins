import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { beforeEach, expect } from "vitest";
import { nativeCommandResult } from "#nativeCommand";
import { recallDelta } from "#recallContext";
import { EMPTY_RECALL_STATE } from "#recallSchema";
import { AgentStore } from "#store";
import { app, makeAgentHome } from "#testing/harness";

const state = { home: "" };
beforeEach(() => {
  state.home = makeAgentHome();
});

it.live("serializes concurrent state updates and recovers a dead owner", () =>
  app(
    Effect.gen(function* () {
      const store = yield* AgentStore;
      const lock = join(state.home, "locks", "counter");
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "2147483647-dead"), "");

      yield* Effect.forEach(
        Array.from({ length: 20 }),
        () =>
          store.withLock(
            "counter",
            Effect.gen(function* () {
              const saved = yield* store.readRecall("codex", "s-1", "main");
              yield* Effect.sleep("2 millis");
              yield* store.writeRecall("codex", "s-1", "main", {
                ...saved,
                generation: saved.generation + 1,
              });
            }),
          ),
        { concurrency: 20 },
      );
      expect((yield* store.readRecall("codex", "s-1", "main")).generation).toBe(20);
    }),
  ),
);

it.live("fails on corrupt state and capture rather than overwriting or acknowledging it", () =>
  app(
    Effect.gen(function* () {
      const store = yield* AgentStore;
      mkdirSync(join(state.home, "recall"), { recursive: true });
      mkdirSync(join(state.home, "sessions"), { recursive: true });
      const file = join(state.home, "recall", "codex-s-1-main.json");
      writeFileSync(file, "{broken");
      writeFileSync(join(state.home, "sessions", "codex-s-1.jsonl"), "{broken\n");

      expect(Exit.isFailure(yield* Effect.exit(store.readRecall("codex", "s-1", "main")))).toBe(
        true,
      );
      expect(Exit.isFailure(yield* Effect.exit(store.readRecords("codex", "s-1")))).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("{broken");
    }),
  ),
);

it("retires removed profiles and leaves oversize facts eligible for later output", () => {
  const profile = {
    key: "profile:member:org:member",
    revision: "v1",
    kind: "profile" as const,
    text: "Old profile",
  };
  const previous = { ...EMPTY_RECALL_STATE, emitted: [profile] };
  const delta = recallDelta({
    previous,
    invalidatedMemoryIds: [],
    invalidatedProfileKeys: [profile.key],
    items: [
      { key: "large", memoryId: "large", revision: "v1", kind: "fact", text: "x".repeat(4000) },
      { key: "small", memoryId: "small", revision: "v1", kind: "fact", text: "Current fact" },
    ],
  });
  expect(delta.context).toContain("Disregard it");
  expect(delta.context.length).toBeLessThanOrEqual(4000);
  expect(delta.emitted.map(({ key }) => key)).toEqual(["small"]);
});

it("reads native Codex command completion without an undocumented transcript", () => {
  expect(
    nativeCommandResult("Chunk ID: 123\nProcess exited with code 1\nFinal output:\n1 failing\n"),
  ).toMatchObject({ value: { exit_code: 1, aggregated_output: "1 failing\n" } });
  expect(
    nativeCommandResult("Process running with session ID 123\nOutput:\npartial"),
  ).toMatchObject({ _tag: "None" });
});

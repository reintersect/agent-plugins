import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { beforeEach, describe, expect } from "vitest";
import { buildEvents, recoverPending, STALE_RUNNING_MS } from "#flush";
import type { CaptureRecord } from "#schema";
import { app, makeAgentHome } from "#testing/harness";

const at = "2026-05-12T10:00:00.000Z";

describe("buildEvents", () => {
  const records: CaptureRecord[] = [
    { kind: "person", observedAt: at, text: "Make reads go through Zero." },
    { kind: "file", observedAt: at, action: "modified", path: "src/app.ts" },
    { kind: "agent", observedAt: at, text: "Rewired it." },
    { kind: "command", observedAt: at, command: "pnpm test", failed: false, category: "test" },
  ];

  it("emits person and agent events in order with one evidence event last", () => {
    expect(buildEvents(records, 0, 0)).toEqual([
      { seq: 0, role: "person", text: "Make reads go through Zero.", observedAt: at },
      { seq: 1, role: "agent", text: "Rewired it.", observedAt: at },
      {
        seq: 2,
        role: "evidence",
        text: "Files modified:\n- src/app.ts\n\nCommands run:\n- `pnpm test` (test) succeeded",
        observedAt: at,
      },
    ]);
  });

  it("continues the sequence from the previous flush and emits nothing when nothing is new", () => {
    expect(buildEvents(records, 2, 7).map((event) => event.seq)).toEqual([7, 8]);
    expect(buildEvents(records, records.length, 4)).toEqual([]);
  });
});

describe("pending recovery", () => {
  const state = { home: "" };

  beforeEach(() => {
    state.home = makeAgentHome();
    mkdirSync(join(state.home, "pending"), { recursive: true });
  });

  const handoff = (name: string, ageMs: number) => {
    const path = join(state.home, "pending", name);

    writeFileSync(
      path,
      JSON.stringify({ host: "claudeCode", sessionId: "s-1", reason: "session-end" }),
    );

    const when = (Date.now() - ageMs) / 1000;

    utimesSync(path, when, when);
  };

  const pending = () => readdirSync(join(state.home, "pending"));

  it.live("relaunches a fresh handoff", () =>
    Effect.gen(function* () {
      handoff("a__session-end__1.json", 1_000);

      expect(yield* app(recoverPending)).toBe(1);
      expect(pending()).toEqual(["a__session-end__1.running"]);
    }),
  );

  it.live("takes back a worker that died mid-flush but leaves a live one alone", () =>
    Effect.gen(function* () {
      handoff("b__session-end__1.running", STALE_RUNNING_MS + 60_000);
      handoff("c__session-end__1.running", 1_000);

      expect(yield* app(recoverPending)).toBe(1);
      expect(pending().sort()).toEqual(["b__session-end__1.running", "c__session-end__1.running"]);
    }),
  );

  it.live("drops handoffs older than the expiry", () =>
    Effect.gen(function* () {
      handoff("d__session-end__1.json", 8 * 24 * 60 * 60 * 1_000);

      expect(yield* app(recoverPending)).toBe(0);
      expect(pending()).toEqual([]);
    }),
  );

  it.live("launches at most five at a time", () =>
    Effect.gen(function* () {
      for (const index of [1, 2, 3, 4, 5, 6, 7]) {
        handoff(`e${index}__session-end__1.json`, 1_000 * index);
      }

      expect(yield* app(recoverPending)).toBe(7);
      expect(pending().filter((name) => name.endsWith(".running"))).toHaveLength(5);
    }),
  );
});

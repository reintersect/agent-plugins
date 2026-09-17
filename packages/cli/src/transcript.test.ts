import { describe, expect, it } from "vitest";
import { activeChain, parseTranscriptRows, transcriptMessages } from "#transcript";

const row = (value: Record<string, unknown>) => JSON.stringify(value);

const FIXTURE = [
  row({
    uuid: "u1",
    parentUuid: null,
    sessionId: "s1",
    type: "user",
    message: { role: "user", content: "Please fix the failing build in packages/cli." },
  }),
  row({
    uuid: "u2",
    parentUuid: "u1",
    sessionId: "s1",
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Looking at the tsconfig." },
        {
          type: "tool_use",
          id: "t1",
          name: "Agent",
          input: {
            subagent_type: "Explore",
            description: "find config",
            prompt: "Where is tsconfig?",
          },
        },
      ],
    },
  }),
  row({
    uuid: "u3",
    parentUuid: "u2",
    sessionId: "s1",
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "tsconfig.json is at the root." },
      ],
    },
  }),
  row({
    uuid: "side1",
    parentUuid: "u2",
    sessionId: "s1",
    isSidechain: true,
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "sidechain noise" }] },
  }),
  row({
    uuid: "u4",
    parentUuid: "u3",
    sessionId: "s1",
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Fixed: allowImportingTsExtensions was missing." }],
    },
  }),
].join("\n");

describe("transcript parsing", () => {
  it("follows the active branch and ignores sidechains and other sessions", () => {
    const rows = parseTranscriptRows(FIXTURE);

    expect(activeChain(rows, "s1").map((entry) => entry.uuid)).toEqual(["u1", "u2", "u3", "u4"]);
    expect(activeChain(rows, "other")).toEqual([]);
  });

  it("extracts prompts, assistant text and subagent work", () => {
    const { messages, leafUuid } = transcriptMessages({
      rows: parseTranscriptRows(FIXTURE),
      sessionId: "s1",
    });

    expect(leafUuid).toBe("u4");
    expect(messages).toEqual([
      { role: "user", content: "Please fix the failing build in packages/cli." },
      { role: "assistant", content: "Looking at the tsconfig." },
      {
        role: "assistant",
        content: "Subagent assignment (Explore: find config):\nWhere is tsconfig?",
      },
      {
        role: "assistant",
        content: "Subagent response (Explore: find config):\ntsconfig.json is at the root.",
      },
      { role: "assistant", content: "Fixed: allowImportingTsExtensions was missing." },
    ]);
  });

  it("resumes after a known leaf and returns nothing when the leaf has not moved", () => {
    const rows = parseTranscriptRows(FIXTURE);

    expect(transcriptMessages({ rows, sessionId: "s1", previousLeafUuid: "u3" }).messages).toEqual([
      { role: "assistant", content: "Fixed: allowImportingTsExtensions was missing." },
    ]);
    expect(transcriptMessages({ rows, sessionId: "s1", previousLeafUuid: "u4" }).messages).toEqual(
      [],
    );
  });

  it("skips local command, system reminder and command-name prompts", () => {
    const noise = [
      row({
        uuid: "n1",
        parentUuid: null,
        sessionId: "s1",
        type: "user",
        message: { role: "user", content: "<local-command-stdout>ok</local-command-stdout>" },
      }),
      row({
        uuid: "n2",
        parentUuid: "n1",
        sessionId: "s1",
        type: "user",
        message: { role: "user", content: "<system-reminder>be careful</system-reminder>" },
      }),
      row({
        uuid: "n3",
        parentUuid: "n2",
        sessionId: "s1",
        type: "user",
        message: { role: "user", content: "<command-name>/clear</command-name>" },
      }),
      row({
        uuid: "n4",
        parentUuid: "n3",
        sessionId: "s1",
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Ready." }] },
      }),
    ].join("\n");

    expect(
      transcriptMessages({ rows: parseTranscriptRows(noise), sessionId: "s1" }).messages,
    ).toEqual([{ role: "assistant", content: "Ready." }]);
  });

  it("captures AskUserQuestion answers and approved plans", () => {
    const fixture = [
      row({
        uuid: "p1",
        parentUuid: null,
        sessionId: "s1",
        type: "user",
        message: { role: "user", content: "Plan the migration." },
      }),
      row({
        uuid: "p2",
        parentUuid: "p1",
        sessionId: "s1",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} },
            {
              type: "tool_use",
              id: "e1",
              name: "ExitPlanMode",
              input: { plan: "Step 1: migrate." },
            },
          ],
        },
      }),
      row({
        uuid: "p3",
        parentUuid: "p2",
        sessionId: "s1",
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "q1", content: "Use Postgres 16." },
            { type: "tool_result", tool_use_id: "e1", content: "approved" },
          ],
        },
      }),
    ].join("\n");
    const { messages } = transcriptMessages({
      rows: parseTranscriptRows(fixture),
      sessionId: "s1",
    });

    expect(messages).toContainEqual({
      role: "user",
      content: "User answers to the agent's questions:\nUse Postgres 16.",
    });
    expect(messages).toContainEqual({
      role: "assistant",
      content: "Approved implementation plan:\nStep 1: migrate.",
    });
  });

  it("redacts secrets found in the transcript", () => {
    const fixture = row({
      uuid: "r1",
      parentUuid: null,
      sessionId: "s1",
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "set api_key = sk-supersecretvalue123" }],
      },
    });
    const { messages } = transcriptMessages({
      rows: parseTranscriptRows(fixture),
      sessionId: "s1",
    });

    expect(messages[0]?.content).not.toContain("sk-supersecretvalue123");
  });

  it("falls back to the host last_assistant_message when the transcript is unreadable", () => {
    expect(
      transcriptMessages({
        rows: [],
        sessionId: "s1",
        fallbackAssistantMessage: "Done, the build passes now.",
      }).messages,
    ).toEqual([{ role: "assistant", content: "Done, the build passes now." }]);
  });
});

import { describe, expect, it } from "vitest";
import { commandCategory, recordsFromTool, renderEvidence } from "#capture";
import type { CaptureRecord } from "#schema";

const base = { cwd: "/repo", observedAt: "2026-05-12T10:00:00.000Z" };

describe("recordsFromTool", () => {
  it("records a repo-relative modified path", () => {
    expect(
      recordsFromTool({
        ...base,
        toolName: "Edit",
        toolInput: { file_path: "/repo/src/app.ts" },
        toolResponse: undefined,
        failed: false,
      }),
    ).toEqual([
      { kind: "file", observedAt: base.observedAt, action: "modified", path: "src/app.ts" },
    ]);
  });

  it("records reads separately from writes without the contents", () => {
    const [record] = recordsFromTool({
      ...base,
      toolName: "Read",
      toolInput: { file_path: "/repo/README.md" },
      toolResponse: "contents that must never leave",
      failed: false,
    });

    expect(record).toMatchObject({ action: "read", path: "README.md" });
    expect(JSON.stringify(record)).not.toContain("must never leave");
  });

  it("captures only successful Codex patch paths, including both sides of a rename", () => {
    const patch = {
      ...base,
      toolName: "apply_patch",
      toolInput: {
        command: [
          "*** Begin Patch",
          "*** Add File: /repo/src/new.ts",
          "+private file contents",
          "+*** Add File: not-a-header.ts",
          "*** Update File: src/old.ts",
          "*** Move to: src/renamed.ts",
          "@@",
          "-private old contents",
          "+private new contents",
          "*** Delete File: /repo/src/deleted.ts",
          "*** End Patch",
        ].join("\n"),
      },
      toolResponse: { exit_code: 0, output: "private output" },
      failed: undefined,
    };

    expect(recordsFromTool(patch)).toEqual(
      ["src/new.ts", "src/old.ts", "src/renamed.ts", "src/deleted.ts"].map((path) => ({
        kind: "file",
        observedAt: base.observedAt,
        action: "modified",
        path,
      })),
    );
    expect(recordsFromTool({ ...patch, toolResponse: { exit_code: 1 } })).toEqual([]);
    expect(recordsFromTool({ ...patch, failed: true })).toEqual([]);
  });

  it("keeps failed command output but never successful output", () => {
    const failed = recordsFromTool({
      ...base,
      toolName: "Bash",
      toolInput: { command: "pnpm test" },
      toolResponse: { stdout: "", stderr: "1 failed", exit_code: 1 },
      failed: undefined,
    });

    expect(failed[0]).toMatchObject({
      kind: "command",
      failed: true,
      category: "test",
      output: "1 failed",
    });

    const passed = recordsFromTool({
      ...base,
      toolName: "Bash",
      toolInput: { command: "pnpm build" },
      toolResponse: { output: "all good", exit_code: 0 },
      failed: undefined,
    });

    expect(passed[0]).toMatchObject({ kind: "command", failed: false, category: "build" });
    expect(JSON.stringify(passed[0])).not.toContain("all good");
  });

  it("redacts secrets inside commands", () => {
    const [record] = recordsFromTool({
      ...base,
      toolName: "Bash",
      toolInput: { command: "curl -H 'Authorization: Bearer supersecrettoken123'" },
      toolResponse: undefined,
      failed: false,
    });

    expect(JSON.stringify(record)).not.toContain("supersecrettoken123");
  });

  it("understands OpenCode's lowercase tools and camelCase paths", () => {
    expect(
      recordsFromTool({
        ...base,
        toolName: "edit",
        toolInput: { filePath: "/repo/src/app.ts", oldString: "a", newString: "b" },
        toolResponse: undefined,
        failed: undefined,
      }),
    ).toEqual([
      { kind: "file", observedAt: base.observedAt, action: "modified", path: "src/app.ts" },
    ]);
    expect(
      recordsFromTool({
        ...base,
        toolName: "bash",
        toolInput: { command: "pnpm test" },
        toolResponse: { output: "1 failed", exit_code: 1 },
        failed: undefined,
      })[0],
    ).toMatchObject({ kind: "command", failed: true, output: "1 failed" });
  });

  it("ignores tools that carry no evidence", () => {
    expect(
      recordsFromTool({
        ...base,
        toolName: "Grep",
        toolInput: { pattern: "x" },
        toolResponse: "",
        failed: false,
      }),
    ).toEqual([]);
  });
});

describe("commandCategory", () => {
  it("classifies test, build and other commands", () => {
    expect(commandCategory("pnpm run test --filter web")).toBe("test");
    expect(commandCategory("cargo build --release")).toBe("build");
    expect(commandCategory("ls -la")).toBe("shell");
  });
});

describe("renderEvidence", () => {
  it("summarises the batch without file contents", () => {
    const records: CaptureRecord[] = [
      { kind: "file", observedAt: base.observedAt, action: "modified", path: "src/a.ts" },
      { kind: "file", observedAt: base.observedAt, action: "modified", path: "src/a.ts" },
      { kind: "file", observedAt: base.observedAt, action: "read", path: "src/b.ts" },
      {
        kind: "command",
        observedAt: base.observedAt,
        command: "pnpm test",
        failed: true,
        category: "test",
        output: "1 failing",
      },
    ];
    const rendered = renderEvidence(records);

    expect(rendered).toContain("Files modified:\n- src/a.ts");
    expect(rendered.match(/- src\/a\.ts/g)).toHaveLength(1);
    expect(rendered).toContain("Files read:\n- src/b.ts");
    expect(rendered).toContain("`pnpm test` (test) failed");
    expect(rendered).toContain("1 failing");
    expect(renderEvidence([])).toBe("");
  });
});

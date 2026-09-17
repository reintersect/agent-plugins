import { Array, Option, Predicate, Schema } from "effect";
import { repositoryRelativePath } from "#git";
import { boundedText, redactSecrets } from "#redact";
import {
  type CaptureRecord,
  type CommandRecord,
  type FileRecord,
  ToolInput,
  ToolResponse,
} from "#schema";

const FILE_TOOL_NAMES = [
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "read",
  "edit",
  "write",
];

const MODIFYING_TOOL_NAMES = ["Edit", "Write", "MultiEdit", "NotebookEdit", "edit", "write"];

const SHELL_TOOL_NAMES = ["Bash", "Shell", "shell", "bash", "run_terminal_cmd"];

const COMMAND_CATEGORIES: ReadonlyArray<readonly [CommandRecord["category"], RegExp]> = [
  [
    "test",
    /(?:^|\s)(?:pytest|py\.test|jest|vitest|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|mvn\s+test|gradle\s+test|make\s+test)(?:\s|$)/i,
  ],
  [
    "build",
    /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?build(?:\s|$)|(?:^|\s)(?:cargo|go|mvn|gradle|make)\s+build(?:\s|$)/i,
  ],
];

const MAX_COMMAND_CHARS = 2_000;

const MAX_COMMAND_OUTPUT_CHARS = 500;

const MAX_EVIDENCE_PATHS = 50;

const decodeResponse = (response: unknown) =>
  Option.getOrElse(
    Schema.decodeUnknownOption(ToolResponse)(response),
    (): typeof ToolResponse.Type => ({}),
  );

export const commandCategory = (command: string): CommandRecord["category"] =>
  COMMAND_CATEGORIES.find(([, pattern]) => pattern.test(command))?.[0] ?? "shell";

export const responseText = (response: unknown): string => {
  if (Predicate.isString(response)) return response;

  const decoded = decodeResponse(response);

  return Array.findFirst(
    [decoded.output, decoded.stdout, decoded.stderr, decoded.error_message],
    (value): value is string => Predicate.isString(value) && value.length > 0,
  ).pipe(Option.getOrElse(() => ""));
};

export const responseFailed = (response: unknown): boolean | undefined => {
  const decoded = decodeResponse(response);

  return Option.fromNullable(decoded.exit_code).pipe(
    Option.map((code) => code !== 0),
    Option.orElse(() => Option.fromNullable(decoded.isError)),
    Option.orElse(() => Option.map(Option.fromNullable(decoded.success), (ok) => !ok)),
    Option.getOrUndefined,
  );
};

export interface ToolCaptureOptions {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolResponse: unknown;
  readonly failed: boolean | undefined;
  readonly cwd: string;
  readonly observedAt: string;
}

export const recordsFromTool = (options: ToolCaptureOptions): ReadonlyArray<CaptureRecord> => {
  const input = Option.getOrElse(
    Schema.decodeUnknownOption(ToolInput)(options.toolInput),
    (): typeof ToolInput.Type => ({}),
  );
  const failed = options.failed ?? responseFailed(options.toolResponse) ?? false;

  if (SHELL_TOOL_NAMES.includes(options.toolName)) {
    const command = boundedText(input.command ?? "", MAX_COMMAND_CHARS);

    if (!command) return [];

    const output = failed
      ? boundedText(responseText(options.toolResponse), MAX_COMMAND_OUTPUT_CHARS)
      : "";

    return [
      {
        kind: "command",
        observedAt: options.observedAt,
        command,
        failed,
        category: commandCategory(command),
        ...(output ? { output } : {}),
      },
    ];
  }

  if (!FILE_TOOL_NAMES.includes(options.toolName)) return [];

  const raw = input.file_path || input.filePath || input.path || input.notebook_path || "";
  const path = repositoryRelativePath(options.cwd, redactSecrets(raw).trim());

  if (!path) return [];

  return [
    {
      kind: "file",
      observedAt: options.observedAt,
      action: MODIFYING_TOOL_NAMES.includes(options.toolName) ? "modified" : "read",
      path,
    },
  ];
};

const uniquePaths = (records: ReadonlyArray<CaptureRecord>, action: FileRecord["action"]) =>
  Array.dedupe(
    records.flatMap((record) =>
      record.kind === "file" && record.action === action ? [record.path] : [],
    ),
  ).slice(0, MAX_EVIDENCE_PATHS);

const commandLine = (command: CommandRecord) => {
  const status = command.failed ? "failed" : "succeeded";
  const label = command.category === "shell" ? "" : ` (${command.category})`;
  const detail = command.output ? `\n  ${command.output.replace(/\n/g, "\n  ")}` : "";

  return `- \`${command.command}\`${label} ${status}${detail}`;
};

export const renderEvidence = (records: ReadonlyArray<CaptureRecord>): string => {
  const modified = uniquePaths(records, "modified");
  const read = uniquePaths(records, "read");
  const commands = records.filter((record): record is CommandRecord => record.kind === "command");

  const sections = [
    modified.length > 0 ? ["Files modified:", ...modified.map((path) => `- ${path}`)] : [],
    read.length > 0 ? ["Files read:", ...read.map((path) => `- ${path}`)] : [],
    commands.length > 0 ? ["Commands run:", ...commands.map(commandLine)] : [],
  ].filter((section) => section.length > 0);

  return sections.map((section) => section.join("\n")).join("\n\n");
};

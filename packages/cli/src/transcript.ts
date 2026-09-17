import { FileSystem } from "@effect/platform";
import { Array, Effect, Option, Schema } from "effect";
import { MAX_MESSAGE_CHARS } from "#config";
import { boundedText, redactSecrets } from "#redact";

export interface TranscriptMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

const ContentBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  tool_use_id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Unknown),
  is_error: Schema.optional(Schema.Boolean),
});

const TranscriptRow = Schema.Struct({
  uuid: Schema.String,
  parentUuid: Schema.optional(Schema.NullOr(Schema.String)),
  sessionId: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.Struct({ kind: Schema.optional(Schema.String) })),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Unknown),
    }),
  ),
});

export type TranscriptRow = typeof TranscriptRow.Type;

const ToolUseInput = Schema.Struct({
  subagent_type: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
});

const IGNORED_PROMPT_PREFIXES = [
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<command-name>",
  "<system-reminder>",
];

const STATUS_TAG = /<status>([\s\S]*?)<\/status>/;

const TOOL_USE_ID_TAG = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/;

const RESULT_TAG = /<result>([\s\S]*?)<\/result>/;

const decodeRow = Schema.decodeUnknownOption(Schema.parseJson(TranscriptRow));

const decodeBlocks = Schema.decodeUnknownOption(Schema.Array(ContentBlock));

const decodeToolInput = Schema.decodeUnknownOption(ToolUseInput);

export const parseTranscriptRows = (text: string) =>
  Array.filterMap(text.split("\n"), (line) =>
    line.trim().length === 0 ? Option.none() : decodeRow(line),
  );

export const activeChain = (
  rows: ReadonlyArray<TranscriptRow>,
  sessionId: string,
): ReadonlyArray<TranscriptRow> => {
  const byUuid = new Map(rows.map((row) => [row.uuid, row]));
  const leaf = Array.findLast(
    rows,
    (row) => row.isSidechain !== true && (row.sessionId ?? "") === sessionId,
  );
  const walk = (row: TranscriptRow, seen: ReadonlySet<string>): ReadonlyArray<TranscriptRow> => {
    const parent = Option.fromNullable(byUuid.get(row.parentUuid ?? ""));

    return Option.match(parent, {
      onNone: () => [row],
      onSome: (next) =>
        seen.has(next.uuid) ? [row] : [...walk(next, new Set([...seen, row.uuid])), row],
    });
  };

  return Option.match(leaf, { onNone: () => [], onSome: (row) => walk(row, new Set([row.uuid])) });
};

const textFromContent = (content: unknown): string =>
  Schema.is(Schema.String)(content)
    ? redactSecrets(content).trim()
    : Option.getOrElse(decodeBlocks(content), () => [])
        .filter((block) => block.type === "text")
        .map((block) => redactSecrets(block.text ?? "").trim())
        .filter((value) => value.length > 0)
        .join("\n\n");

export const humanPromptText = (row: TranscriptRow): string => {
  const kind = row.origin?.kind;
  const content = row.message?.content;

  if (row.type !== "user" || (kind !== undefined && kind !== "human")) return "";
  if (!Schema.is(Schema.String)(content)) return "";

  const text = redactSecrets(content)
    .trim()
    .replace(/^<!-- attach -->/, "")
    .trim();

  return IGNORED_PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix)) ? "" : text;
};

const tagValue = (text: string, tag: RegExp) => text.match(tag)?.[1]?.trim() ?? "";

interface ToolUse {
  readonly name: string;
  readonly input: typeof ToolUseInput.Type;
}

const agentHeading = (label: string, input: ToolUse["input"]) => {
  const agentType = redactSecrets(input.subagent_type ?? "agent").trim() || "agent";
  const description = redactSecrets(input.description ?? "").trim();

  return description ? `${label} (${agentType}: ${description}):` : `${label} (${agentType}):`;
};

const collectToolUses = (chain: ReadonlyArray<TranscriptRow>) =>
  new Map(
    chain.flatMap((row) =>
      Option.getOrElse(decodeBlocks(row.message?.content), () => []).flatMap((block) =>
        block.type === "tool_use" && block.id !== undefined
          ? [
              [
                block.id,
                {
                  name: block.name ?? "",
                  input: Option.getOrElse(decodeToolInput(block.input), () => ({})),
                } satisfies ToolUse,
              ] as const,
            ]
          : [],
      ),
    ),
  );

const agentMessages = (tool: ToolUse, result: string): ReadonlyArray<TranscriptMessage> => {
  const prompt = redactSecrets(tool.input.prompt ?? "").trim();
  const trimmed = redactSecrets(result).trim();

  if (!trimmed || trimmed.startsWith("Async agent launched successfully.")) return [];

  const assignment = prompt
    ? [
        {
          role: "assistant" as const,
          content: boundedText(
            `${agentHeading("Subagent assignment", tool.input)}\n${prompt}`,
            MAX_MESSAGE_CHARS,
          ),
        },
      ]
    : [];

  return [
    ...assignment,
    {
      role: "assistant",
      content: boundedText(
        `${agentHeading("Subagent response", tool.input)}\n${trimmed}`,
        MAX_MESSAGE_CHARS,
      ),
    },
  ];
};

const notificationMessages = (
  content: string,
  toolUses: ReadonlyMap<string, ToolUse>,
): ReadonlyArray<TranscriptMessage> => {
  const tool = toolUses.get(tagValue(content, TOOL_USE_ID_TAG));
  const result = tagValue(content, RESULT_TAG);

  return tagValue(content, STATUS_TAG) === "completed" && tool?.name === "Agent" && result
    ? agentMessages(tool, result)
    : [];
};

const toolResultMessages = (
  block: typeof ContentBlock.Type,
  toolUses: ReadonlyMap<string, ToolUse>,
): ReadonlyArray<TranscriptMessage> => {
  const tool = toolUses.get(block.tool_use_id ?? "");

  if (!tool || block.is_error === true) return [];

  const result = textFromContent(block.content);

  if (tool.name === "Agent") return agentMessages(tool, result);
  if (tool.name === "AskUserQuestion" && result) {
    return [
      {
        role: "user",
        content: boundedText(
          `User answers to the agent's questions:\n${result}`,
          MAX_MESSAGE_CHARS,
        ),
      },
    ];
  }

  const plan = tool.name === "ExitPlanMode" ? redactSecrets(tool.input.plan ?? "").trim() : "";

  return plan
    ? [
        {
          role: "assistant",
          content: boundedText(`Approved implementation plan:\n${plan}`, MAX_MESSAGE_CHARS),
        },
      ]
    : [];
};

const rowMessages = (
  row: TranscriptRow,
  toolUses: ReadonlyMap<string, ToolUse>,
): ReadonlyArray<TranscriptMessage> => {
  const role = row.message?.role ?? "";
  const content = row.message?.content;

  if (role === "user" && Schema.is(Schema.String)(content)) {
    if (content.startsWith("<task-notification>")) return notificationMessages(content, toolUses);

    const human = humanPromptText(row);

    return human ? [{ role: "user", content: boundedText(human, MAX_MESSAGE_CHARS) }] : [];
  }

  return Option.getOrElse(decodeBlocks(content), () => []).flatMap((block) => {
    if (role === "assistant" && block.type === "text") {
      const text = boundedText(block.text ?? "", MAX_MESSAGE_CHARS);

      return text ? [{ role: "assistant" as const, content: text }] : [];
    }

    return role === "user" && block.type === "tool_result"
      ? toolResultMessages(block, toolUses)
      : [];
  });
};

const startIndex = (
  chain: ReadonlyArray<TranscriptRow>,
  previousLeafUuid: string,
  promptHint: string,
) => {
  if (previousLeafUuid) {
    const found = chain.findIndex((row) => row.uuid === previousLeafUuid);

    return found >= 0 ? found + 1 : 0;
  }

  const hint = redactSecrets(promptHint).trim();

  return Array.findLastIndex(chain, (row) => {
    const text = humanPromptText(row);

    return text.length > 0 && (!hint || text === hint);
  }).pipe(Option.getOrElse(() => 0));
};

export interface TranscriptOptions {
  readonly rows: ReadonlyArray<TranscriptRow>;
  readonly sessionId: string;
  readonly previousLeafUuid?: string;
  readonly promptHint?: string;
  readonly fallbackAssistantMessage?: string;
}

export const transcriptMessages = (options: TranscriptOptions) => {
  const chain = activeChain(options.rows, options.sessionId);
  const fallback = boundedText(options.fallbackAssistantMessage ?? "", MAX_MESSAGE_CHARS);
  const leafUuid = Option.getOrElse(Array.last(chain), () => ({ uuid: "" })).uuid;

  if (chain.length === 0) {
    return {
      messages: fallback ? [{ role: "assistant" as const, content: fallback }] : [],
      leafUuid,
    };
  }
  if (options.previousLeafUuid && leafUuid === options.previousLeafUuid) {
    return { messages: [] as ReadonlyArray<TranscriptMessage>, leafUuid };
  }

  const toolUses = collectToolUses(chain);
  const from = startIndex(chain, options.previousLeafUuid ?? "", options.promptHint ?? "");
  const messages = chain.slice(from).flatMap((row) => rowMessages(row, toolUses));
  const withFallback =
    fallback && !messages.some((message) => message.content === fallback)
      ? [...messages, { role: "assistant" as const, content: fallback }]
      : messages;

  return { messages: withFallback, leafUuid };
};

export const readTranscriptChunk = (path: string, offset: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const size = Number((yield* fs.stat(path)).size);
    const start = offset >= 0 && offset <= size ? offset : 0;
    const bytes = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path, { flag: "r" });

        yield* file.seek(FileSystem.Size(start), "start");

        return yield* file.readAlloc(FileSystem.Size(size - start));
      }),
    );
    const text = Option.match(bytes, {
      onNone: () => "",
      onSome: (value) => new TextDecoder().decode(value),
    });
    const lastNewline = text.lastIndexOf("\n");

    if (lastNewline < 0) return { text: "", endOffset: start };

    const complete = text.slice(0, lastNewline + 1);

    return { text: complete, endOffset: start + Buffer.byteLength(complete, "utf8") };
  }).pipe(Effect.orElseSucceed(() => ({ text: "", endOffset: offset })));

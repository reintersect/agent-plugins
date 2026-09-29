import { Option, Schema } from "effect";

const Completion = Schema.Struct({
  exit_code: Schema.Int,
  aggregated_output: Schema.String,
});

export const nativeCommandResult = (response: unknown) => {
  const structured = Schema.decodeUnknownOption(Completion)(response);
  if (Option.isSome(structured)) return structured;
  if (!Schema.is(Schema.String)(response)) return Option.none();

  const code = response.match(/^(?:Process exited with code|Exit code:)\s*(-?\d+)\s*$/m);
  if (code === null) return Option.none();

  return Option.some({
    exit_code: Number(code[1]),
    aggregated_output: response
      .split(/\n(?:Final output|Output):\s*\n/)
      .slice(1)
      .join("\n"),
  });
};

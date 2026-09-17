const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(authorization\s*[:=]\s*(?:bearer|token)\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [
    /((?:api[_-]?key|secret[_-]?access[_-]?key|session[_-]?token)\s*[:=]\s*)[^\s"']+/gi,
    "$1[REDACTED]",
  ],
  [
    /((?:access[_-]?token|refresh[_-]?token|password|credential)\s*[:=]\s*)[^\s&"']+/gi,
    "$1[REDACTED]",
  ],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]"],
  [/\brei_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]"],
  [/\b(?:ASIA|AKIA)[A-Z0-9]{12,}\b/g, "[REDACTED]"],
  [/\b(?:ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]"],
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED]"],
  [
    /("(?:api[_-]?key|password|secret(?:[_-]?access[_-]?key)?|(?:access|refresh|session)[_-]?token|token|authorization|credential)"\s*:\s*")(?:\\.|[^"\\])*/gi,
    "$1[REDACTED]",
  ],
];

export const redactSecrets = (value: unknown): string =>
  SECRET_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    typeof value === "string" ? value : JSON.stringify(value ?? ""),
  );

export const boundedText = (value: unknown, limit: number): string => {
  const text = redactSecrets(value).trim();

  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
};

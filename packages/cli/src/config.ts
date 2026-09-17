import { Config, Option, Redacted } from "effect";

export const DEFAULT_API_URL = "https://api.reintersect.com";

export const CLIENT_NAME = "Reintersect for coding agents";

export const CLIENT_VERSION = "0.1.0";

export const LOOPBACK_PORTS = [41893, 41894, 41895] as const;

export const REDIRECT_URIS = LOOPBACK_PORTS.map((port) => `http://127.0.0.1:${port}/callback`);

export const MAX_MESSAGE_CHARS = 12_000;

export const trimSlash = (url: string) => url.replace(/\/+$/, "");

export const AgentHome = Config.option(Config.string("REINTERSECT_AGENT_HOME"));

export const ApiUrlOverride = Config.option(
  Config.string("REINTERSECT_API_URL").pipe(Config.map(trimSlash)),
);

export const ApiKey = Config.option(Config.redacted("REINTERSECT_API_KEY")).pipe(
  Config.map(Option.filter((key) => Redacted.value(key).trim().length > 0)),
);

export const FlushWorkerBin = Config.option(Config.string("REINTERSECT_AGENT_BIN"));

export const HostProjectDir = Config.string("CLAUDE_PROJECT_DIR").pipe(
  Config.orElse(() => Config.string("CURSOR_PROJECT_DIR")),
  Config.withDefault(process.cwd()),
);

export const CursorTranscriptPath = Config.option(Config.string("CURSOR_TRANSCRIPT_PATH"));

export const CodexPluginRoot = Config.option(Config.string("PLUGIN_ROOT"));

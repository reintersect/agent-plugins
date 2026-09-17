import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, type Layer } from "effect";
import { AppLive } from "#runtime";

export const makeGitRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "rei-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });

  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/reintersect/app.git");
  git(
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  );

  return dir;
};

export const makeAgentHome = () => {
  const home = mkdtempSync(join(tmpdir(), "rei-home-"));
  const noop = join(home, "noop.mjs");

  writeFileSync(noop, "process.exit(0);\n");
  process.env.REINTERSECT_AGENT_HOME = home;
  process.env.REINTERSECT_AGENT_BIN = noop;

  return home;
};

export const app = <A, E>(effect: Effect.Effect<A, E, Layer.Layer.Success<typeof AppLive>>) =>
  effect.pipe(Effect.provide(AppLive));

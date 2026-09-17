import type { Plugin } from "@opencode-ai/plugin";
import { hooksFor, loadCommands, PACKAGE_DIR, spawnHook } from "./hooks.ts";

export const ReintersectPlugin: Plugin = async ({ client, directory }) =>
  hooksFor({
    client,
    commands: loadCommands(),
    directory,
    packageDir: PACKAGE_DIR,
    run: spawnHook,
  });

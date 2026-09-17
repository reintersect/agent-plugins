import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

export default defineConfig({
  entry: ["src/main.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node20",
  noExternal: [/.*/],
  dts: false,
  clean: true,
  env: { CLIENT_VERSION: version },
  outputOptions: { entryFileNames: "reintersect-agent.mjs", banner: "#!/usr/bin/env node" },
});

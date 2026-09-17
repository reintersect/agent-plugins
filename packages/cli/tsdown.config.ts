import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node20",
  noExternal: [/.*/],
  dts: false,
  clean: true,
  outputOptions: { entryFileNames: "reintersect-agent.mjs", banner: "#!/usr/bin/env node" },
});

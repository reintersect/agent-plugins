import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "packages", "cli", "dist", "reintersect-agent.mjs");
const SKILLS = join(ROOT, "skills");

const PLUGIN_ROOTS: Record<string, string> = {
  "claude-code": "${CLAUDE_PLUGIN_ROOT}",
  cursor: "${CURSOR_PLUGIN_ROOT}",
};

const OPENCODE_DIST = join(ROOT, "packages", "opencode", "dist");

const render = (template: string, pluginRoot: string) =>
  template.replaceAll("{{PLUGIN_ROOT}}", pluginRoot).replaceAll("{{PREFIX}}", "/reintersect:");

const openCodeCommand = (name: string, template: string) => {
  const match = template.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const description = match?.[1]?.match(/^description: (.*)$/m)?.[1] ?? name;

  return {
    name,
    description,
    template: (match?.[2] ?? template).replaceAll("{{PREFIX}}", "/reintersect-").trim(),
  };
};

const emit = async (path: string, content: string, check: boolean) => {
  const existing = await readFile(path, "utf8").catch(() => undefined);

  if (existing === content) return undefined;
  if (check) return path;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);

  return undefined;
};

const run = async (check: boolean) => {
  const bundle = await readFile(BUNDLE, "utf8").catch(() => {
    throw new Error(`missing ${BUNDLE}; run pnpm --filter @reintersect/agent-cli build first`);
  });
  const skillNames = (await readdir(SKILLS, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const stale = (
    await Promise.all(
      Object.entries(PLUGIN_ROOTS).map(async ([directory, pluginRoot]) => {
        const pluginDir = join(ROOT, "plugins", directory);
        const outputs = [
          emit(join(pluginDir, "dist", "reintersect-agent.mjs"), bundle, check),
          ...skillNames.map(async (name) =>
            emit(
              join(pluginDir, "skills", name, "SKILL.md"),
              render(await readFile(join(SKILLS, name, "SKILL.md.tmpl"), "utf8"), pluginRoot),
              check,
            ),
          ),
        ];

        return Promise.all(outputs);
      }),
    )
  )
    .flat()
    .filter((path): path is string => path !== undefined);

  const commands = await Promise.all(
    skillNames.map(async (name) =>
      openCodeCommand(name, await readFile(join(SKILLS, name, "SKILL.md.tmpl"), "utf8")),
    ),
  );

  await mkdir(OPENCODE_DIST, { recursive: true });
  await writeFile(join(OPENCODE_DIST, "reintersect-agent.mjs"), bundle);
  await writeFile(join(OPENCODE_DIST, "commands.json"), `${JSON.stringify(commands, null, 2)}\n`);

  if (stale.length > 0) {
    process.stderr.write(
      `These files differ from a fresh build; run pnpm build and commit the result:\n${stale
        .map((path) => `  ${path.slice(ROOT.length + 1)}`)
        .join("\n")}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    check
      ? "plugins/* match a fresh build\n"
      : `wrote ${Object.keys(PLUGIN_ROOTS).length} plugin bundles, ${Object.keys(PLUGIN_ROOTS).length * skillNames.length} skills and the OpenCode package\n`,
  );
};

await run(process.argv.includes("--check"));

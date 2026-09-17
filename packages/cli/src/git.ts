import { Command } from "@effect/platform";
import { Duration, Effect, Option, String } from "effect";

const GIT_TIMEOUT = Duration.millis(500);

const run = (cwd: string, args: ReadonlyArray<string>) =>
  Command.string(Command.make("git", "-C", cwd, ...args)).pipe(
    Effect.timeout(GIT_TIMEOUT),
    Effect.map((text) => Option.liftPredicate(text.trim(), String.isNonEmpty)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

export const parseRepositoryFullName = (remote: string) =>
  Option.fromNullable(
    remote
      .trim()
      .replace(/\.git$/, "")
      .match(/[/:]([^/:\s]+)\/([^/\s]+)$/),
  ).pipe(Option.map((match) => `${match[1]}/${match[2]}`));

export const gitRepository = (cwd: string) =>
  run(cwd, ["remote", "get-url", "origin"]).pipe(
    Effect.map(Option.flatMap(parseRepositoryFullName)),
  );

export const gitInfo = (cwd: string) =>
  Effect.all(
    { repository: gitRepository(cwd), branch: run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) },
    { concurrency: 2 },
  ).pipe(
    Effect.map(({ branch, repository }) => ({
      repository: Option.getOrUndefined(repository),
      branch: Option.getOrUndefined(branch),
    })),
  );

export const repositoryRelativePath = (cwd: string, filePath: string) => {
  const root = `${cwd.replace(/\/+$/, "")}/`;

  return filePath.startsWith(root) ? filePath.slice(root.length) : filePath;
};

import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe, expect } from "vitest";
import { gitInfo, parseRepositoryFullName, repositoryRelativePath } from "#git";
import { app, makeGitRepo } from "#testing/harness";

describe("parseRepositoryFullName", () => {
  it("reads owner/name out of every remote form", () => {
    expect(parseRepositoryFullName("https://github.com/reintersect/app.git")).toEqual(
      Option.some("reintersect/app"),
    );
    expect(parseRepositoryFullName("git@github.com:reintersect/app.git")).toEqual(
      Option.some("reintersect/app"),
    );
    expect(parseRepositoryFullName("ssh://git@github.com/reintersect/app")).toEqual(
      Option.some("reintersect/app"),
    );
    expect(parseRepositoryFullName("")).toEqual(Option.none());
  });
});

describe("repositoryRelativePath", () => {
  it("strips the working directory prefix and leaves outside paths alone", () => {
    expect(repositoryRelativePath("/repo", "/repo/src/app.ts")).toBe("src/app.ts");
    expect(repositoryRelativePath("/repo/", "/repo/src/app.ts")).toBe("src/app.ts");
    expect(repositoryRelativePath("/repo", "/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("gitInfo", () => {
  it.live("reads the remote and branch of a real checkout", () =>
    Effect.gen(function* () {
      const info = yield* app(gitInfo(makeGitRepo()));

      expect(info).toEqual({ repository: "reintersect/app", branch: "main" });
    }),
  );

  it.live("returns nothing outside a checkout instead of failing", () =>
    Effect.gen(function* () {
      const info = yield* app(gitInfo("/"));

      expect(info.repository).toBeUndefined();
    }),
  );
});

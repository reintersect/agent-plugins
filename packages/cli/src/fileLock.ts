import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Option, Schedule, Schema } from "effect";

class FileLockBusy extends Schema.TaggedError<FileLockBusy>()("FileLockBusy", {}) {}

const processExists = (pid: number) =>
  Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.match({
      onSuccess: () => true,
      onFailure: (error) =>
        !Option.exists(
          Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(error.error),
          ({ code }) => code === "ESRCH",
        ),
    }),
  );

export const withFileLock = <A, E, R>(directory: string, operation: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const prepared = yield* Effect.acquireRelease(
        fs.makeTempDirectory({
          directory: dirname(directory),
          prefix: ".acquire-",
        }),
        (temporary) => fs.remove(temporary, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      const owner = `${process.pid}-${randomUUID()}`;

      yield* fs.writeFileString(`${prepared}/${owner}`, "", { mode: 0o600 });

      const acquire = fs.rename(prepared, directory).pipe(
        Effect.catchTag("SystemError", (error) =>
          Effect.gen(function* () {
            if (!(yield* fs.exists(directory))) return yield* error;

            const owners = yield* fs.readDirectory(directory);
            yield* Effect.forEach(
              owners,
              (name) =>
                Effect.gen(function* () {
                  const pid = Number(name.split("-")[0]);
                  if (!Number.isSafeInteger(pid) || pid <= 0 || (yield* processExists(pid))) return;
                  yield* fs.remove(`${directory}/${name}`).pipe(Effect.ignore);
                }),
              { discard: true },
            );
            return yield* new FileLockBusy();
          }),
        ),
        Effect.retry({
          while: (error) => error._tag === "FileLockBusy",
          schedule: Schedule.spaced("20 millis").pipe(
            Schedule.intersect(Schedule.recurs(50)),
            Schedule.jittered,
          ),
        }),
      );

      return yield* Effect.acquireUseRelease(
        acquire,
        () => operation,
        () =>
          fs
            .remove(`${directory}/${owner}`)
            .pipe(Effect.zipRight(fs.remove(directory)), Effect.ignore),
      );
    }),
  );

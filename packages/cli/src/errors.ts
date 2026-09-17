import { Data } from "effect";

export class NotAuthenticatedError extends Data.TaggedError("NotAuthenticatedError")<{
  readonly message: string;
}> {}

export class LoginError extends Data.TaggedError("LoginError")<{ readonly message: string }> {}

export class BackendCallError extends Data.TaggedError("BackendCallError")<{
  readonly tool: string;
  readonly message: string;
}> {}

export class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

import { Effect } from "effect";
import type { HookInput } from "#hostEvents";
import { currentCredentialKey } from "#identity";
import type { CaptureRecord, SessionState } from "#schema";
import { AgentStore } from "#store";

interface CaptureOptions {
  readonly input: HookInput;
  readonly state: SessionState;
  readonly records: ReadonlyArray<CaptureRecord>;
}

export const captureRecords = ({ input, state, records }: CaptureOptions) =>
  Effect.gen(function* () {
    const store = yield* AgentStore;
    if (state.scopeMismatch || state.scopeChanged) {
      const credentialKey = yield* currentCredentialKey;
      return {
        ...state,
        heldRecords: [
          ...state.heldRecords,
          ...records.map((record) => ({
            credentialKey,
            promptVersion: state.promptVersion,
            record,
          })),
        ],
      };
    }
    yield* Effect.forEach(
      records,
      (record) => store.appendRecord(input.host, input.sessionId, record),
      { discard: true },
    );
    return state;
  });

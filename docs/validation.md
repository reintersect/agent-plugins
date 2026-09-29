# Continuous memory validation

Run from the plugin repository:

```sh
pnpm build
pnpm check
pnpm test:native
```

`pnpm check` covers host normalization, capture, full-message splitting, revision deltas,
compaction, subagents, account changes, immutable retries, pause, storage concurrency,
corrupt-file preservation, and Cursor/OpenCode regressions. Generated bundles and skills
must match a fresh build.

`pnpm test:native` requires Claude Code 2.1.283+ and Codex 0.158.0+ on PATH. It creates
isolated temporary host configuration, a synthetic repository, and local MCP/model APIs.
It makes no paid model calls and does not modify the user's installed plugins or credentials.
Codex's automation-only hook-trust override applies only to the locally built fixture plugin.

The native check asserts that memory reaches the clients' actual model request bodies on
initial and resumed turns, that Claude runs compaction and subagent hooks, and that both
clients receive asynchronous context during tool work. It advances the fixture recall
ledger's timestamp by 61 seconds to make a background refresh eligible; it does not measure
one minute of real elapsed time. Model responses are deterministic fixture responses, so
this is a delivery/adapter test, not an evaluation of reasoning quality.

Artifacts remain under the printed temporary directory: captured JSONL, hook output,
synthetic requests, and received MCP calls. A local hook invocation, received ingestion
request, accepted production upload, extraction completion, and useful model behavior are
separate claims.

## Backend checks

The matching backend change retains the 0.2.0 response fields and adds structured recall,
authenticated upload scope, explicit fact/profile invalidations, and completeness. Deploy
that change before releasing these plugin bundles.

Focused backend checks cover rendered IDs/budgets, scoped invalidation, degraded repository
and member access, no reinforcement on retrieval, and upload rejection before persistence.
Repository resolver tests distinguish a verified missing repository from a lookup outage.

The matching backend change passed full CI in Reintersect PR #1833: build, lint,
typechecks, unit tests, and all eight E2E shards. Focused backend tests also passed
with fixture layers. Local browser repetitions verified the CI fixture repairs in
its prerequisite PR #1834. Production extraction latency and the few-minute
freshness target have not been measured by these fixture checks.

## Release and recovery

1. Deploy the additive backend contract.
2. Run the plugin's normal release workflow after review; it owns version stamping.
3. Update the marketplaces and installed plugin caches, then restart/reopen the host.
4. In Codex, review the changed hooks. Use status to confirm activity in the new session.
5. Verify production upload acceptance and extraction independently before claiming freshness.

A confirmed account, workspace, backend, or repository change permanently holds the current
session's unsent tail; start a new host session. Already-snapshotted batches retain their
original scope and can retry there. Unverified records and older unbound batches remain
locally preserved for ownership review; automatic recovery never guesses another scope.

Official contracts checked while implementing this change:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex plugins](https://learn.chatgpt.com/docs/plugins)

---
name: login
description: Sign this machine in to Reintersect so its tools work in every local coding agent. Use when the user asks to sign in or connect Reintersect, or when a Reintersect tool reports that it is not authenticated.
disable-model-invocation: true
---

# Sign in to Reintersect

One sign-in covers Claude Code, Cursor and Codex on this machine, because all
three run the same binary against the same token file.

In Codex, explain before signing in that setup also requires reviewing and
trusting Reintersect's hooks (`/hooks` in the Codex CLI). Without that step, automatic recall
and capture do not run. Guide the user through it; do not mark hooks trusted
by editing Codex settings or bypassing its review.


```bash
node "${CURSOR_PLUGIN_ROOT}/dist/reintersect-agent.mjs" login
```

The command opens a browser to Reintersect's consent page and prints the URL as
well, so it also works over SSH. Pick the workspace on the consent page; that
choice binds this machine.

If the user has a `rei_…` API key instead, tell them to export
`REINTERSECT_API_KEY` in their shell profile: the key replaces the browser
login entirely.

Afterwards confirm with the status skill. In Codex, start a new session after
sign-in and hook review so the MCP server reloads its tools and the session-start
hook runs. Setup is incomplete until the workspace is reachable, Reintersect's
tools are available, and the status skill verifies capture for that new session.

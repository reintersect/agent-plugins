---
name: pause
description: Pause Reintersect capture on this machine. Use for private work, or when the user asks to stop recording sessions.
disable-model-invocation: true
---

# Pause capture

In Codex, find this skill's absolute `SKILL.md` path in the loaded skill list.
The plugin root is two directories above this skill's directory. Use that path instead
of `${CLAUDE_PLUGIN_ROOT}` in the command below.


```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/reintersect-agent.mjs" pause
```

Confirm the new state and tell the user that memories already stored stay
searchable, and that batches captured but not yet uploaded are held rather than
discarded. The Reintersect tools keep working while capture is paused; only the
automatic recording of this session stops.

Turn it back on with the resume skill.

---
name: resume
description: Resume Reintersect capture on this machine after it was paused.
disable-model-invocation: true
---

# Resume capture

In Codex, find this skill's absolute `SKILL.md` path in the loaded skill list.
The plugin root is two directories above this skill's directory. Use that path instead
of `${CLAUDE_PLUGIN_ROOT}` in the command below.


```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/reintersect-agent.mjs" resume
```

Confirm the new state. Batches that were captured while paused are uploaded at
the next session start.

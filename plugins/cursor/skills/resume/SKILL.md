---
name: resume
description: Resume Reintersect capture on this machine after it was paused.
disable-model-invocation: true
---

# Resume capture


```bash
node "${CURSOR_PLUGIN_ROOT}/dist/reintersect-agent.mjs" resume
```

Confirm the new state. Batches that were captured while paused are uploaded at
the next session start.

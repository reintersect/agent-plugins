---
name: status
description: Show whether Reintersect is working here, covering sign-in, the bound workspace, capture state and pending uploads. Use when the user asks whether Reintersect is connected, why a memory is missing, or when a Reintersect tool fails.
disable-model-invocation: false
---

# Reintersect status

```bash
node "${CURSOR_PLUGIN_ROOT}/dist/reintersect-agent.mjs" status
```

Summarise the report in plain language and relay its `hint` lines as the next
step. If sign-in is missing or the API is unreachable, say clearly that
memories are NOT being created and point at `/reintersect:login`. Never report an
authentication failure as "no memories found".

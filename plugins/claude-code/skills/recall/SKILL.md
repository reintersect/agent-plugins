---
name: recall
description: Look up what Reintersect already knows about this repository, the team or the user. Use when earlier work, a decision, a convention or a preference may already be recorded.
argument-hint: "[question]"
disable-model-invocation: true
---

# Recall from Reintersect

Call the `SearchMemories` tool with the user's question as `query`. Leave
`repository` unset: the plugin fills in the current repository from the git
remote.

Report the facts as answers, with their dates when the date matters. If nothing
comes back, say so plainly instead of guessing, and do not invent memory ids.

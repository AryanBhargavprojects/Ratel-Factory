---
description: Ping Ratel Factory health and verify all subagent roles are responding.
---

This is the /ratel factory health command.
Call the ratel_ping_agents tool exactly once.
The plugin automatically bridges OpenCode credentials (from ~/.local/share/opencode/auth.json)
into Pi auth storage (~/.pi/agent/auth.json) for any providers used in ratel.json that do not
already have Pi credentials configured. This lets Ratel reuse existing OpenCode provider keys
without additional configuration.
Do not call bash, read, grep, find, ls, or inspect the codebase.
After the tool result, report only the factory health summary and per-agent statuses.

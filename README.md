# opencode-agent-fallback

An [opencode](https://opencode.ai) plugin that gives each agent its own ordered model fallback chain. When a model fails
with a fallback-eligible error, the plugin resends your original message to the next model in that agent's chain,
keeping the same agent, and cools down the failing pool or model so later requests skip it.

## Quick start

1. Add the plugin to your opencode config (`~/.config/opencode/opencode.json`):

   ```json
   { "plugin": ["opencode-agent-fallback@0.2.0"] }
   ```

2. Create `~/.config/opencode/agent-fallback.json`:

   ```json
   {
   	"agents": {
   		"build": ["anthropic/claude-sonnet-5-5", { "model": "openai/gpt-6.1-sol", "variant": "high" }]
   	},
   	"default": ["opencode/deepseek-v4.1-flash"]
   }
   ```

3. Restart opencode. When `build` fails on its model, the opencode log shows
   `falling back for session <id>: <provider>/<model>` and the answer comes from the next entry.

> Run only one fallback plugin at a time. Two plugins resending the same failure produce duplicate requests.

## What it does

| Feature                 | Behavior                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-agent chains        | Each opencode agent gets an ordered list of models (with an optional variant). Agents not listed use `default`.                                                                                             |
| Faithful resend         | The original user message is resent with an explicit `agent`, `model` and `variant`, so the session keeps its agent.                                                                                        |
| Error classes           | `pool-unavailable` (401/403, region or "model not found" errors) > `quota` > `rate-limit` (429) > `transient` (5xx, overloaded). Anything else, including user aborts, never falls back.                    |
| Cooldowns               | `pool-unavailable` and `quota` cool the whole pool; `rate-limit` and `transient` cool only that model. Cooldowns are shared across sessions and a later failure never shortens one.                         |
| Stops endless retries   | When opencode keeps retrying a fallback-eligible error, the plugin aborts the retry loop and resends to the next entry. With no next entry it only aborts errors that can never succeed (pool-unavailable). |
| Phantom Task-cancel fix | A `task` tool call reported as "Task cancelled" while its subagent keeps running gets the subagent's final answer instead (bounded wait, see `taskGuard`).                                                  |

## Configuration

The first file that exists wins:

1. The path in the `OPENCODE_AGENT_FALLBACK_CONFIG` environment variable.
2. `<project>/.opencode/agent-fallback.json`
3. `~/.config/opencode/agent-fallback.json`

Invalid values are reported in the opencode log and ignored; the plugin never crashes opencode.

```json
{
	"enabled": true,
	"agents": {
		"build": ["anthropic/claude-sonnet-5-5", { "model": "openai/gpt-6.1-sol", "variant": "high" }],
		"explore": []
	},
	"default": ["opencode/deepseek-v4.1-flash"],
	"pools": { "anthropic": "claude", "anthropic-work": "claude" },
	"cooldownSeconds": { "rateLimit": 60, "quota": 1800, "transient": 30, "poolUnavailable": 21600 },
	"taskGuard": { "enabled": true, "timeoutSeconds": 600, "resendInterruptedChild": true }
}
```

| Key               | Default     | Meaning                                                                                                                                                               |
| ----------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | `true`      | Turns the whole plugin on or off.                                                                                                                                     |
| `agents`          | `{}`        | Chain per opencode agent name. An entry is `"provider/model"` or `{ "model": "provider/model", "variant": "high" }`. An empty chain disables fallback for that agent. |
| `default`         | `[]`        | Chain for agents missing from `agents`.                                                                                                                               |
| `pools`           | `{}`        | Maps a providerID to a pool name, so providers sharing a subscription cool down together. An unmapped provider is its own pool.                                       |
| `cooldownSeconds` | see example | Cooldown length per error class.                                                                                                                                      |
| `taskGuard`       | see example | Phantom Task-cancel recovery: on/off, how long to wait for the subagent, and whether to resume an idle subagent once.                                                 |

Keep chains in this file, not inside `opencode.json` agent blocks: opencode forwards unknown agent fields to providers.

## Requirements

- opencode 1.18.34 or newer. The package ships TypeScript source, which opencode's Bun runtime loads directly.

## Development

```bash
bun install
bun run check   # tests, typecheck, prettier, eslint
```

## License

MIT. Design inspired by [razroo/opencode-model-fallback](https://github.com/razroo/opencode-model-fallback); no code
copied.

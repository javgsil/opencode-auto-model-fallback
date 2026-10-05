# opencode-auto-model-fallback

[![npm version](https://img.shields.io/npm/v/opencode-auto-model-fallback.svg)](https://www.npmjs.com/package/opencode-auto-model-fallback)
[![license](https://img.shields.io/npm/l/opencode-auto-model-fallback.svg)](LICENSE)
[![CI](https://github.com/javgsil/opencode-auto-model-fallback/actions/workflows/ci.yml/badge.svg)](https://github.com/javgsil/opencode-auto-model-fallback/actions/workflows/ci.yml)

An [opencode](https://opencode.ai) plugin that gives each agent an ordered model fallback chain. When a model fails
with a fallback-eligible error, the plugin resends your original message to the next model in that agent's chain,
keeping the same agent, and cools down the failing pool or model so later requests skip it.

## Why

- opencode can retry forever on some provider errors (region blocks, a pool that is down) that will never succeed.
- opencode configures one model per agent, so one provider failure stops that agent completely.
- This plugin interrupts that loop and moves the request to the next model in the chain, without changing the agent
  or losing the conversation.

## What it does

| Feature                  | Behavior                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-agent chains         | Each opencode agent gets an ordered list of models (with an optional variant). Agents not listed use `default`.                                                                                             |
| Faithful resend          | The original user message is resent with an explicit `agent`, `model` and `variant`, so the session keeps its agent.                                                                                        |
| Error classes            | `pool-unavailable` (401/403, region or "model not found" errors) > `quota` > `rate-limit` (429) > `transient` (5xx, overloaded). Anything else, including user aborts, never falls back.                    |
| Cooldowns                | `pool-unavailable` and `quota` cool the whole pool; `rate-limit` and `transient` cool only that model. Cooldowns are shared across sessions and a later failure never shortens one.                         |
| Stops endless retries    | When opencode keeps retrying a fallback-eligible error, the plugin aborts the retry loop and resends to the next entry. With no next entry it only aborts errors that can never succeed (pool-unavailable). |
| Model-not-found handling | When opencode itself rejects the configured model (`Model not found: <provider>/<model>.`), the plugin still advances the chain instead of stalling.                                                        |
| Phantom Task-cancel fix  | A `task` tool call reported as "Task cancelled" while its subagent keeps running gets the subagent's final answer instead (bounded wait, see `taskGuard`).                                                  |

## Install

Add the plugin to your opencode config (`~/.config/opencode/opencode.json`):

```json
{ "plugin": ["opencode-auto-model-fallback@0.2.0"] }
```

> Run only one fallback plugin at a time. Two plugins resending the same failure produce duplicate requests.

## Quick start

1. Add the plugin entry above and restart opencode.

2. Create `~/.config/opencode/agent-fallback.json`:

   ```json
   {
   	"agents": {
   		"build": ["anthropic/claude-sonnet-5-5", { "model": "openai/gpt-6.1-sol", "variant": "high" }]
   	},
   	"default": ["opencode/deepseek-v4.1-flash"]
   }
   ```

3. When `build` fails on its model, the opencode log shows
   `falling back for session <id>: <provider>/<model>` and the answer comes from the next entry.

## Configuration

The first file that exists wins:

1. The path in the `OPENCODE_AGENT_FALLBACK_CONFIG` environment variable.
2. `<project>/.opencode/agent-fallback.json`
3. `~/.config/opencode/agent-fallback.json`

A missing file means built-in defaults. Invalid values are reported in the opencode log and ignored; the plugin
never crashes opencode.

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

| Key               | Default   | Meaning                                                                                                                         |
| ----------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | `true`    | Turns the whole plugin on or off.                                                                                               |
| `agents`          | `{}`      | Chain per opencode agent name. An empty chain disables fallback for that agent.                                                 |
| `default`         | `[]`      | Chain for agents missing from `agents`.                                                                                         |
| `pools`           | `{}`      | Maps a providerID to a pool name, so providers sharing a subscription cool down together. An unmapped provider is its own pool. |
| `cooldownSeconds` | see below | Cooldown length per error class.                                                                                                |
| `taskGuard`       | see below | Phantom Task-cancel recovery: on/off, how long to wait for the subagent, and whether to resume an idle subagent once.           |

Keep chains in this file, not inside `opencode.json` agent blocks: opencode forwards unknown agent fields to
providers.

### Chain entries

An entry is either a plain string or an object:

| Format                                             | Meaning                     |
| -------------------------------------------------- | --------------------------- |
| `"provider/model"`                                 | The model, default variant. |
| `{ "model": "provider/model", "variant": "high" }` | The model plus a variant.   |

The provider/model reference splits on the **first** `/`, so a modelID may itself contain `/` or `:`.

### Pools

`pools` groups providerIDs under one pool name (`"anthropic": "claude"`). Failures that cool a whole pool cool every
provider mapped to it. A provider with no mapping is its own pool. Pool selection uses the failing model's provider.

### Cooldowns

| Error class        | Cools           | Default                          |
| ------------------ | --------------- | -------------------------------- |
| `pool-unavailable` | The whole pool  | `poolUnavailable`: 21600 s (6 h) |
| `quota`            | The whole pool  | `quota`: 1800 s (30 min)         |
| `rate-limit`       | That model only | `rateLimit`: 60 s                |
| `transient`        | That model only | `transient`: 30 s                |

- One tracker serves every session: a model cooled by one session is skipped by all later selections.
- A later failure never shortens an active cooldown.
- Variants of the same model share one cooldown key.

### taskGuard

Recovers phantom `Task cancelled` errors (opencode issue #45556):

| Key                      | Default | Meaning                                                        |
| ------------------------ | ------- | -------------------------------------------------------------- |
| `enabled`                | `true`  | Turns the recovery hook on or off.                             |
| `timeoutSeconds`         | `600`   | Hard budget for waiting on one orphaned subagent session.      |
| `resendInterruptedChild` | `true`  | Prompt an idle child that never produced a final answer, once. |

## How it works

### Error classes

Classification is pure and pattern-based; when several classes match, the first one wins:

1. `pool-unavailable` — HTTP 401/403, or messages about global regions, availability in your region, "model not
   found", "not supported".
2. `quota` — usage limits, `quota exceeded`, low credit balance, `insufficient_quota`.
3. `rate-limit` — HTTP 429, rate limit or "too many requests" messages.
4. `transient` — HTTP 500/502/503/504/529, "overloaded" or "service unavailable".

Everything else is `not-fallback`: no cooldown, no resend, the host keeps its native behaviour (user aborts always
land here).

### Cooldown scope

`pool-unavailable` and `quota` cool the whole pool; `rate-limit` and `transient` cool only the exact
`provider/model` (all variants of that model share the key). Selection skips cooled entries and takes the first
eligible one after the failing model.

### Retry-loop interruption

opencode reports its own retries as session status events. When such a retry matches a fallback-eligible class, the
plugin records the failure, applies the cooldown, and **aborts opencode's retry loop** before sending the original
parts again with the next chain entry — two concurrent generations of one request would race for the session. If the
chain has no next entry left, it aborts the loop only for `pool-unavailable`, the one class that can never succeed
on retry.

### opencode-side "Model not found" rejections

opencode's own run loop rejects an unknown model with `Model not found: <provider>/<model>.` **before** the request
reaches `chat.params`, so a rejected resend would otherwise leave the plugin without a model identity and stall the
chain. The plugin matches that error on the exact live model id and advances the chain anyway, bypassing its
pending-resend guard and duplicate-failure suppression.

### Phantom Task-cancel recovery

The `task` tool sometimes reports `Task cancelled` tens of milliseconds after starting while the subagent session
keeps running as an orphan. The plugin watches for that failed tool part, waits for the orphaned subagent within the
`taskGuard.timeoutSeconds` budget, and rewrites the part with the subagent's real final answer. It never blocks
longer than the budget and never throws.

## Logs and troubleshooting

- opencode writes logs to `~/.local/share/opencode/log/`.
- A successful fallback logs `falling back for session <id>: <provider>/<model>` (plus ` (variant)` when the entry
  has a variant).
- An invalid configuration is reported there as `<path>: <message>` (for example
  `default[0]: model must be "provider/modelID"`) and the offending value is ignored.
- `fallback chain exhausted for agent "<agent>" in session <id>` means no entry is left for this request;
  `every remaining entry is cooling down` means eligible entries exist but all are in cooldown.
- `unknown agent "<name>" in the agent-fallback configuration` means the agent name does not exist in this opencode
  install; that chain is never used.

## Compatibility

- opencode 1.18.34 or newer.
- The package ships TypeScript source and runs on opencode's Bun runtime; there is no build step.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting and supported versions. Releases are published only by
the owner through GitHub Actions with npm trusted publishing (OIDC) and staged approval with 2FA; npm tokens are
disallowed.

## Development

```bash
bun install
bun run check   # tests, typecheck, prettier, eslint
```

## License

MIT. Design inspired by [razroo/opencode-model-fallback](https://github.com/razroo/opencode-model-fallback); no code
copied.

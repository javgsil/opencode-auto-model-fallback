/**
 * Known-agent discovery for config validation. The preferred source is the
 * live agent list from `client.app.agents()`; the fallback is the `config`
 * hook's agent map. When neither is available, validation degrades silently
 * to doing nothing.
 */

import type { Hooks, Plugin } from '@opencode-ai/plugin'

type Client = Parameters<Plugin>[0]['client']
type ConfigHookInput = Parameters<NonNullable<Hooks['config']>>[0]

/**
 * Agents the SDK's `Config.agent` map declares by name, so the config-hook
 * fallback does not flag them as unknown when they are simply absent from a
 * user's configuration file.
 */
export const BUILT_IN_CONFIG_AGENTS = ['plan', 'build', 'general', 'explore'] as const

/**
 * Known agent names from the server, or `null` when the source is unavailable,
 * fails, or yields no names. Never throws.
 */
export async function fetchKnownAgents(client: Client): Promise<ReadonlySet<string> | null> {
	try {
		if (typeof client.app?.agents !== 'function') return null
		const result = await client.app.agents()
		const data: unknown = (result as { data?: unknown } | undefined)?.data
		if (!Array.isArray(data)) return null
		const names = new Set<string>()
		for (const entry of data) {
			if (typeof entry !== 'object' || entry === null) continue
			const name: unknown = (entry as { name?: unknown }).name
			if (typeof name === 'string' && name.length > 0) names.add(name)
		}
		return names.size > 0 ? names : null
	} catch {
		return null
	}
}

/**
 * Known agent names from the `config` hook's agent map, or `null` when the
 * hook input exposes no agent map at all.
 */
export function knownAgentsFromConfig(config: ConfigHookInput): ReadonlySet<string> | null {
	if (config.agent === undefined) return null
	const names = new Set<string>(BUILT_IN_CONFIG_AGENTS)
	for (const key of Object.keys(config.agent)) names.add(key)
	return names
}

/** Configured agent names not present in the known set, in configuration order. */
export function unknownAgentNames(configured: Readonly<Record<string, unknown>>, known: ReadonlySet<string>): string[] {
	return Object.keys(configured).filter((name) => !known.has(name))
}

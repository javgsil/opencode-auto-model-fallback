import { describe, expect, test } from 'bun:test'
import type { Hooks, Plugin } from '@opencode-ai/plugin'
import { fetchKnownAgents, knownAgentsFromConfig, unknownAgentNames } from '../../src/runtime/agents'

type Client = Parameters<Plugin>[0]['client']
type ConfigHookInput = Parameters<NonNullable<Hooks['config']>>[0]

function clientWithAgents(data: unknown): Client {
	return {
		app: {
			agents: async () => ({ data })
		}
	} as unknown as Client
}

describe('fetchKnownAgents', () => {
	test('returns the agent names from client.app.agents()', async () => {
		const client = clientWithAgents([{ name: 'build' }, { name: 'plan' }, { name: 'my-agent' }])
		expect(await fetchKnownAgents(client)).toEqual(new Set(['build', 'plan', 'my-agent']))
	})

	test('ignores entries without a usable name', async () => {
		const client = clientWithAgents([{ name: 'build' }, { name: '' }, { description: 'no name' }, null])
		expect(await fetchKnownAgents(client)).toEqual(new Set(['build']))
	})

	test('returns null when app.agents is unavailable', async () => {
		expect(await fetchKnownAgents({} as unknown as Client)).toBeNull()
	})

	test('returns null when the call fails', async () => {
		const client = {
			app: {
				agents: async () => {
					throw new Error('server unavailable')
				}
			}
		} as unknown as Client
		expect(await fetchKnownAgents(client)).toBeNull()
	})

	test('returns null when the payload is not a non-empty agent list', async () => {
		expect(await fetchKnownAgents(clientWithAgents(undefined))).toBeNull()
		expect(await fetchKnownAgents(clientWithAgents({ name: 'build' }))).toBeNull()
		expect(await fetchKnownAgents(clientWithAgents([]))).toBeNull()
	})
})

describe('knownAgentsFromConfig', () => {
	test('combines the config agent map with the built-in agents declared by the SDK config type', () => {
		const config: ConfigHookInput = { agent: { 'my-agent': {}, 'another-one': {} } }
		const known = knownAgentsFromConfig(config)
		expect(known).not.toBeNull()
		for (const name of ['plan', 'build', 'general', 'explore', 'my-agent', 'another-one']) {
			expect(known?.has(name)).toBe(true)
		}
	})

	test('returns null when the config exposes no agent map', () => {
		expect(knownAgentsFromConfig({} as ConfigHookInput)).toBeNull()
	})
})

describe('unknownAgentNames', () => {
	test('returns configured names that are not known, in configuration order', () => {
		const configured = { coder: [], 'typo-agent': [], builder: [] }
		const known = new Set(['coder', 'builder'])
		expect(unknownAgentNames(configured, known)).toEqual(['typo-agent'])
	})

	test('returns an empty list when everything is known or nothing is configured', () => {
		expect(unknownAgentNames({ coder: [] }, new Set(['coder']))).toEqual([])
		expect(unknownAgentNames({}, new Set(['coder']))).toEqual([])
		expect(unknownAgentNames({ constructor: [] }, new Set(['constructor']))).toEqual([])
	})
})

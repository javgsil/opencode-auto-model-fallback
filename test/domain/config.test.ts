import { describe, expect, test } from 'bun:test'
import { chainFor, parseConfig, parseModelRef, resolvePool } from '../../src/domain/config'

const DEFAULT_COOLDOWNS = { rateLimit: 60, quota: 1800, transient: 30, poolUnavailable: 21600 }

describe('parseConfig', () => {
	test('applies defaults for missing and nullish config', () => {
		for (const raw of [undefined, null, {}]) {
			const { config, issues } = parseConfig(raw)
			expect(config).toEqual({
				enabled: true,
				agents: {},
				default: [],
				pools: {},
				cooldownSeconds: DEFAULT_COOLDOWNS
			})
			expect(issues).toEqual([])
		}
	})

	test('parses string and object chain entries', () => {
		const { config, issues } = parseConfig({
			default: ['anthropic/claude-sonnet-4-5', { model: 'openai/gpt-5.2', variant: 'high' }]
		})
		expect(issues).toEqual([])
		expect(config.default).toEqual([
			{ model: 'anthropic/claude-sonnet-4-5' },
			{ model: 'openai/gpt-5.2', variant: 'high' }
		])
	})

	test('parses agents, pools, enabled and partial cooldown overrides', () => {
		const { config, issues } = parseConfig({
			enabled: false,
			agents: { coder: ['anthropic/claude-sonnet-4-5'], reviewer: [] },
			pools: { 'opencode-go': 'opencode', 'minimax-coding-plan': 'minimax' },
			cooldownSeconds: { quota: 600 }
		})
		expect(issues).toEqual([])
		expect(config.enabled).toBe(false)
		expect(config.agents.coder).toEqual([{ model: 'anthropic/claude-sonnet-4-5' }])
		expect(config.agents.reviewer).toEqual([])
		expect(config.pools).toEqual({ 'opencode-go': 'opencode', 'minimax-coding-plan': 'minimax' })
		expect(config.cooldownSeconds).toEqual({ ...DEFAULT_COOLDOWNS, quota: 600 })
	})

	test('drops invalid entries and reports them as issues instead of throwing', () => {
		const { config, issues } = parseConfig({
			default: ['nonsense', { model: 42 }, 'anthropic/', { model: 'a/b', variant: 3 }, 'ok/model']
		})
		expect(config.default).toEqual([{ model: 'ok/model' }])
		expect(issues.map((issue) => issue.path)).toEqual(['default[0]', 'default[1]', 'default[2]', 'default[3]'])
		expect(issues.every((issue) => issue.severity === 'error')).toBe(true)
	})

	test('drops invalid agent chain entries with a path under agents', () => {
		const { config, issues } = parseConfig({ agents: { coder: ['no-slash', 'anthropic/claude'] } })
		expect(config.agents.coder).toEqual([{ model: 'anthropic/claude' }])
		expect(issues).toHaveLength(1)
		expect(issues[0]?.path).toBe('agents.coder[0]')
	})

	test('warns on unknown top-level keys', () => {
		const { config, issues } = parseConfig({ enabled: true, surprise: 1, another: true })
		expect(config.enabled).toBe(true)
		expect(issues).toHaveLength(2)
		expect(issues.every((issue) => issue.severity === 'warning')).toBe(true)
		expect(issues.map((issue) => issue.path)).toEqual(['surprise', 'another'])
	})

	test('warns on wrong-typed fields and keeps defaults', () => {
		const { config, issues } = parseConfig({
			enabled: 'yes',
			default: 'not-an-array',
			cooldownSeconds: { quota: 'soon' },
			agents: { coder: 'not-an-array' },
			pools: { a: 1 }
		})
		expect(config.enabled).toBe(true)
		expect(config.default).toEqual([])
		expect(config.cooldownSeconds).toEqual(DEFAULT_COOLDOWNS)
		expect(config.agents.coder).toBeUndefined()
		expect(config.pools).toEqual({})
		expect(issues.length).toBeGreaterThanOrEqual(5)
		expect(issues.every((issue) => issue.severity !== 'error')).toBe(true)
	})

	test('never throws on non-object input', () => {
		expect(parseConfig('nope').issues).toHaveLength(1)
		expect(parseConfig(42).config.enabled).toBe(true)
		expect(parseConfig(42).issues[0]?.path).toBe('config')
	})
})

describe('parseModelRef', () => {
	test('splits on the first slash only', () => {
		expect(parseModelRef('anthropic/claude-sonnet-4-5')).toEqual({
			providerID: 'anthropic',
			modelID: 'claude-sonnet-4-5'
		})
		expect(parseModelRef('ollama/qwen3.8-code:latest')).toEqual({
			providerID: 'ollama',
			modelID: 'qwen3.8-code:latest'
		})
		expect(parseModelRef('nano-gpt/deepseek/deepseek-v4.1-flash')).toEqual({
			providerID: 'nano-gpt',
			modelID: 'deepseek/deepseek-v4.1-flash'
		})
	})

	test('rejects missing or empty halves', () => {
		expect(parseModelRef('anthropic')).toBeNull()
		expect(parseModelRef('anthropic/')).toBeNull()
		expect(parseModelRef('/claude')).toBeNull()
		expect(parseModelRef('')).toBeNull()
	})
})

describe('chainFor', () => {
	const config = parseConfig({
		default: ['anthropic/claude-sonnet-4-5'],
		agents: { coder: ['openai/gpt-5.2'], 'empty-agent': [] }
	}).config

	test('returns the agent chain when defined', () => {
		expect(chainFor('coder', config)).toEqual([{ model: 'openai/gpt-5.2' }])
	})

	test('returns an empty agent chain as-is (no fallback for that agent)', () => {
		expect(chainFor('empty-agent', config)).toEqual([])
	})

	test('falls back to the default chain when the agent is missing or undefined', () => {
		expect(chainFor('unknown-agent', config)).toEqual([{ model: 'anthropic/claude-sonnet-4-5' }])
		expect(chainFor(undefined, config)).toEqual([{ model: 'anthropic/claude-sonnet-4-5' }])
		expect(chainFor('coder', parseConfig({}).config)).toEqual([])
	})
})

describe('resolvePool', () => {
	test('uses the mapping when present', () => {
		expect(resolvePool('opencode-go', { 'opencode-go': 'opencode' })).toBe('opencode')
		expect(resolvePool('minimax-coding-plan', { 'minimax-coding-plan': 'minimax' })).toBe('minimax')
	})

	test('defaults to the providerID when unmapped', () => {
		expect(resolvePool('anthropic', { 'opencode-go': 'opencode' })).toBe('anthropic')
		expect(resolvePool('ollama', {})).toBe('ollama')
	})
})

describe('prototype-pollution safety (review finding R3)', () => {
	test('inherited object names resolve to the default chain, never to Object members', () => {
		const empty = parseConfig({}).config
		expect(chainFor('constructor', empty)).toEqual([])
		expect(chainFor('toString', empty)).toEqual([])
		expect(chainFor('__proto__', empty)).toEqual([])

		const withDefault = parseConfig({ default: ['anthropic/claude-sonnet-4-5'] }).config
		expect(chainFor('constructor', withDefault)).toEqual([{ model: 'anthropic/claude-sonnet-4-5' }])
		expect(chainFor('toString', withDefault)).toEqual([{ model: 'anthropic/claude-sonnet-4-5' }])
		expect(chainFor('__proto__', withDefault)).toEqual([{ model: 'anthropic/claude-sonnet-4-5' }])
	})

	test('inherited names resolve to the providerID in resolvePool', () => {
		expect(resolvePool('constructor', {})).toBe('constructor')
		expect(resolvePool('toString', {})).toBe('toString')
		expect(resolvePool('__proto__', {})).toBe('__proto__')
		expect(resolvePool('hasOwnProperty', {})).toBe('hasOwnProperty')
	})

	test('explicitly configured special keys round-trip through parseConfig', () => {
		const raw = JSON.parse(
			'{"agents":{"__proto__":["a/b"],"constructor":["c/d"],"toString":["e/f"]},"pools":{"__proto__":"proto-pool","constructor":"ctor-pool"}}'
		)
		const { config, issues } = parseConfig(raw)
		expect(issues).toEqual([])
		expect(Object.keys(config.agents)).toEqual(['__proto__', 'constructor', 'toString'])
		expect(chainFor('__proto__', config)).toEqual([{ model: 'a/b' }])
		expect(chainFor('constructor', config)).toEqual([{ model: 'c/d' }])
		expect(chainFor('toString', config)).toEqual([{ model: 'e/f' }])
		expect(resolvePool('__proto__', config.pools)).toBe('proto-pool')
		expect(resolvePool('constructor', config.pools)).toBe('ctor-pool')
	})

	test('dictionaries in the parsed config have a null prototype', () => {
		const { config } = parseConfig({ agents: { coder: ['a/b'] }, pools: { p: 'q' } })
		expect(Object.getPrototypeOf(config.agents)).toBeNull()
		expect(Object.getPrototypeOf(config.pools)).toBeNull()
		expect(config.agents.coder).toEqual([{ model: 'a/b' }])
		expect(config.pools.p).toBe('q')
	})

	test('assigning __proto__ does not hijack the dictionary prototype', () => {
		const { config } = parseConfig(JSON.parse('{"agents":{"__proto__":["a/b"]}}'))
		expect(Object.prototype.hasOwnProperty.call(config.agents, '__proto__')).toBe(true)
		expect(chainFor('constructor', config)).toEqual([])
	})
})

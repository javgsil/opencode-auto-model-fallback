/**
 * Pure config parsing and validation. No file I/O: the caller reads the file
 * and hands us the raw JSON value. Parsing is tolerant: invalid input is
 * dropped and reported as a `ConfigIssue`, never thrown.
 */

export type ChainEntry = {
	/** `provider/modelID`; the modelID may itself contain `/` or `:`. */
	model: string
	variant?: string
}

export type CooldownSeconds = {
	rateLimit: number
	quota: number
	transient: number
	poolUnavailable: number
}

/** Phantom `Task cancelled` guard (opencode #45556). */
export type TaskGuardConfig = {
	/** Whether `experimental.chat.messages.transform` is wired at all. */
	enabled: boolean
	/** Hard budget for waiting on one orphaned subagent session. */
	timeoutSeconds: number
	/** Prompt an idle child that never produced a final answer, exactly once. */
	resendInterruptedChild: boolean
}

export type PluginConfig = {
	enabled: boolean
	agents: Record<string, ChainEntry[]>
	default: ChainEntry[]
	/** Optional map grouping providerIDs under one pool name. */
	pools: Record<string, string>
	cooldownSeconds: CooldownSeconds
	taskGuard: TaskGuardConfig
}

export type ConfigIssue = {
	severity: 'error' | 'warning'
	/** Dotted location, e.g. `default[0]`, `agents.coder[1]`, `cooldownSeconds.quota`. */
	path: string
	message: string
}

export type ParseConfigResult = {
	config: PluginConfig
	issues: ConfigIssue[]
}

export const DEFAULT_COOLDOWNS: CooldownSeconds = {
	rateLimit: 60,
	quota: 1800,
	transient: 30,
	poolUnavailable: 21600
}

export const DEFAULT_TASK_GUARD: TaskGuardConfig = {
	enabled: true,
	timeoutSeconds: 600,
	resendInterruptedChild: true
}

const KNOWN_KEYS = new Set(['enabled', 'agents', 'default', 'pools', 'cooldownSeconds', 'taskGuard'])
const COOLDOWN_KEYS = ['rateLimit', 'quota', 'transient', 'poolUnavailable'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Null-prototype dictionary. Config keys are untrusted JSON: a plain `{}` would
 * resolve inherited names (`constructor`, `toString`) and route a `__proto__`
 * key through the legacy prototype setter instead of storing it.
 */
function dict<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>
}

/** Own-property lookup: inherited object members never count as configured keys. */
function own<T>(dictionary: Record<string, T>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : undefined
}

/** Split `provider/modelID` on the FIRST slash only; `null` when either side is missing. */
export function parseModelRef(model: string): { providerID: string; modelID: string } | null {
	const separator = model.indexOf('/')
	if (separator <= 0 || separator === model.length - 1) return null
	return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
}

function parseEntry(raw: unknown, path: string, issues: ConfigIssue[]): ChainEntry | null {
	let model: unknown
	let variant: unknown = undefined
	if (typeof raw === 'string') {
		model = raw
	} else if (isRecord(raw)) {
		model = raw.model
		if ('variant' in raw) variant = raw.variant
	} else {
		issues.push({ severity: 'error', path, message: 'chain entry must be a string or an object' })
		return null
	}
	if (typeof model !== 'string' || parseModelRef(model) === null) {
		issues.push({ severity: 'error', path, message: 'model must be "provider/modelID"' })
		return null
	}
	if (variant !== undefined) {
		if (typeof variant !== 'string' || variant.length === 0) {
			issues.push({ severity: 'error', path, message: 'variant must be a non-empty string' })
			return null
		}
		return { model, variant }
	}
	return { model }
}

function parseChain(raw: unknown[], path: string, issues: ConfigIssue[]): ChainEntry[] {
	const entries: ChainEntry[] = []
	raw.forEach((item, index) => {
		const entry = parseEntry(item, `${path}[${index}]`, issues)
		if (entry !== null) entries.push(entry)
	})
	return entries
}

function applyCooldowns(raw: unknown, target: CooldownSeconds, issues: ConfigIssue[]): void {
	if (raw === undefined) return
	if (!isRecord(raw)) {
		issues.push({ severity: 'warning', path: 'cooldownSeconds', message: 'must be an object of seconds' })
		return
	}
	for (const key of COOLDOWN_KEYS) {
		if (!(key in raw)) continue
		const value = raw[key]
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
			target[key] = value
		} else {
			issues.push({
				severity: 'warning',
				path: `cooldownSeconds.${key}`,
				message: 'must be a non-negative number of seconds'
			})
		}
	}
}

/**
 * Task-guard overrides. Unknown keys inside `taskGuard` are ignored, matching
 * how `cooldownSeconds` treats its own unknown keys.
 */
function applyTaskGuard(raw: unknown, target: TaskGuardConfig, issues: ConfigIssue[]): void {
	if (raw === undefined) return
	if (!isRecord(raw)) {
		issues.push({ severity: 'warning', path: 'taskGuard', message: 'must be an object' })
		return
	}
	if ('enabled' in raw) {
		if (typeof raw.enabled === 'boolean') target.enabled = raw.enabled
		else issues.push({ severity: 'warning', path: 'taskGuard.enabled', message: 'must be a boolean' })
	}
	if ('timeoutSeconds' in raw) {
		const value = raw.timeoutSeconds
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) target.timeoutSeconds = value
		else
			issues.push({
				severity: 'warning',
				path: 'taskGuard.timeoutSeconds',
				message: 'must be a positive number of seconds'
			})
	}
	if ('resendInterruptedChild' in raw) {
		if (typeof raw.resendInterruptedChild === 'boolean') target.resendInterruptedChild = raw.resendInterruptedChild
		else
			issues.push({
				severity: 'warning',
				path: 'taskGuard.resendInterruptedChild',
				message: 'must be a boolean'
			})
	}
}

export function parseConfig(raw: unknown): ParseConfigResult {
	const issues: ConfigIssue[] = []
	const config: PluginConfig = {
		enabled: true,
		agents: dict<ChainEntry[]>(),
		default: [],
		pools: dict<string>(),
		cooldownSeconds: { ...DEFAULT_COOLDOWNS },
		taskGuard: { ...DEFAULT_TASK_GUARD }
	}
	if (raw === undefined || raw === null) return { config, issues }
	if (!isRecord(raw)) {
		issues.push({ severity: 'error', path: 'config', message: 'configuration must be an object' })
		return { config, issues }
	}

	for (const key of Object.keys(raw)) {
		if (!KNOWN_KEYS.has(key)) {
			issues.push({ severity: 'warning', path: key, message: 'unknown configuration key' })
		}
	}

	if ('enabled' in raw) {
		if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled
		else issues.push({ severity: 'warning', path: 'enabled', message: 'must be a boolean' })
	}

	if ('default' in raw) {
		if (Array.isArray(raw.default)) config.default = parseChain(raw.default, 'default', issues)
		else issues.push({ severity: 'warning', path: 'default', message: 'must be an array of chain entries' })
	}

	if ('agents' in raw) {
		if (isRecord(raw.agents)) {
			for (const [name, value] of Object.entries(raw.agents)) {
				if (Array.isArray(value)) config.agents[name] = parseChain(value, `agents.${name}`, issues)
				else issues.push({ severity: 'warning', path: `agents.${name}`, message: 'must be an array of chain entries' })
			}
		} else {
			issues.push({ severity: 'warning', path: 'agents', message: 'must be an object keyed by agent name' })
		}
	}

	if ('pools' in raw) {
		if (isRecord(raw.pools)) {
			for (const [providerID, pool] of Object.entries(raw.pools)) {
				if (typeof pool === 'string' && pool.length > 0) config.pools[providerID] = pool
				else issues.push({ severity: 'warning', path: `pools.${providerID}`, message: 'must be a pool name string' })
			}
		} else {
			issues.push({ severity: 'warning', path: 'pools', message: 'must be an object of provider-to-pool mappings' })
		}
	}

	if ('cooldownSeconds' in raw) applyCooldowns(raw.cooldownSeconds, config.cooldownSeconds, issues)

	if ('taskGuard' in raw) applyTaskGuard(raw.taskGuard, config.taskGuard, issues)

	return { config, issues }
}

/** Pool name for a providerID: mapped pool when configured, otherwise the providerID itself. */
export function resolvePool(providerID: string, pools: Record<string, string>): string {
	return own(pools, providerID) ?? providerID
}

/**
 * Chain for an agent. A defined agent chain wins even when empty: an empty
 * array means "no fallback for this agent", not "fall back to default".
 * Lookups are own-property only, so inherited names like `constructor` fall
 * through to the default chain.
 */
export function chainFor(agentName: string | undefined, config: PluginConfig): ChainEntry[] {
	if (agentName !== undefined) {
		const chain = own(config.agents, agentName)
		if (chain !== undefined) return chain
	}
	return config.default
}

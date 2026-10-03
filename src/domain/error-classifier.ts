/**
 * Pure error classification for the fallback chain. No I/O, no state.
 *
 * Precedence when several classes match: pool-unavailable > quota > rate-limit > transient.
 * Everything else is `not-fallback` so the host keeps its native behaviour.
 */

export type ErrorClass =
	| { kind: 'quota' }
	| { kind: 'rate-limit' }
	| { kind: 'pool-unavailable' }
	| { kind: 'transient' }
	| { kind: 'not-fallback' }

export type ErrorClassRule = {
	/** HTTP status codes that alone identify the class. */
	statuses: readonly number[]
	/** Lowercase substrings matched case-insensitively against the message. */
	patterns: readonly string[]
}

/**
 * Single extension point: T3 adds observed messages/status codes here, never in code branches.
 * Non-terminal classes only; `not-fallback` is the absence of any match.
 */
export const ERROR_PATTERN_TABLE: Readonly<Record<Exclude<ErrorClass['kind'], 'not-fallback'>, ErrorClassRule>> = {
	'pool-unavailable': {
		statuses: [401, 403],
		patterns: ['requires global regions', 'not available in your region', 'model not found', 'not supported']
	},
	quota: {
		statuses: [],
		patterns: ['usage limit', 'quota exceeded', 'credit balance too low', 'insufficient_quota']
	},
	'rate-limit': {
		statuses: [429],
		patterns: ['rate limit', 'too many requests', 'rate_limit_error']
	},
	transient: {
		statuses: [500, 502, 503, 504, 529],
		patterns: ['overloaded', 'service unavailable']
	}
}

/** Highest priority first. */
const PRECEDENCE = ['pool-unavailable', 'quota', 'rate-limit', 'transient'] as const

export function classifyError(input: { message?: string; statusCode?: number; providerID?: string }): ErrorClass {
	const message = typeof input.message === 'string' ? input.message.toLowerCase() : ''
	const statusCode = typeof input.statusCode === 'number' ? input.statusCode : undefined
	for (const kind of PRECEDENCE) {
		const rule = ERROR_PATTERN_TABLE[kind]
		if (statusCode !== undefined && rule.statuses.includes(statusCode)) return { kind }
		if (message.length > 0 && rule.patterns.some((pattern) => message.includes(pattern))) return { kind }
	}
	return { kind: 'not-fallback' }
}

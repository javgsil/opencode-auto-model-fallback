/**
 * Pure cooldown tracking with an injectable clock, scoped by error kind:
 * `pool-unavailable`/`quota` cool a whole pool, `rate-limit`/`transient` cool
 * only the exact model (`provider/modelID` — all variants share that key).
 * One tracker serves the whole plugin (all sessions): a target cooled by one
 * session's failure is skipped by every later selection, until the clock passes
 * its deadline.
 */

import type { CooldownSeconds } from './config'
import type { ErrorClass } from './error-classifier'

/** Fallback-eligible error kinds that can start a cooldown. */
export type CooldownKind = Exclude<ErrorClass['kind'], 'not-fallback'>

const DURATION_KEY: Readonly<Record<CooldownKind, keyof CooldownSeconds>> = {
	'rate-limit': 'rateLimit',
	quota: 'quota',
	transient: 'transient',
	'pool-unavailable': 'poolUnavailable'
}

/** What a cooldown applies to: pool kinds cool the whole pool, model kinds one model. */
export type CooldownScope = 'pool' | 'model'

/** Single extension point: a kind's scope lives here, next to its duration. */
const SCOPE: Readonly<Record<CooldownKind, CooldownScope>> = {
	'pool-unavailable': 'pool',
	quota: 'pool',
	'rate-limit': 'model',
	transient: 'model'
}

/** A chain entry's pool plus its `provider/modelID` key. Variants share the model key. */
export type CooldownTarget = {
	pool: string
	model: string
}

export type PoolCooldowns = {
	/**
	 * Start a cooldown for `kind`, scoped to the target's pool or its model as the
	 * kind dictates, lasting the configured duration of `kind`. Never shortens an
	 * active longer cooldown on the same key; a zero (or already-expired) duration
	 * leaves the target eligible.
	 */
	mark: (kind: CooldownKind, target: CooldownTarget) => void
	/** Whether the target's pool or its model still carries a deadline after the clock reading. */
	isCooling: (target: CooldownTarget) => boolean
}

export function createPoolCooldowns(seconds: CooldownSeconds, clock: () => number = Date.now): PoolCooldowns {
	// Deadline per key in epoch milliseconds; an expired entry simply never reads as cooling.
	// Two maps keep pool and model keys from ever colliding.
	const poolDeadlines = new Map<string, number>()
	const modelDeadlines = new Map<string, number>()
	const active = (deadlines: Map<string, number>, key: string): boolean => {
		const until = deadlines.get(key)
		return until !== undefined && until > clock()
	}
	return {
		mark(kind: CooldownKind, target: CooldownTarget): void {
			// Durations are seconds from the config; the clock reads epoch milliseconds.
			const until = clock() + seconds[DURATION_KEY[kind]] * 1000
			// A non-finite deadline would corrupt the active-deadline comparison: drop it.
			// A negative duration lands in the past and a zero one lands exactly now: neither cools.
			if (!Number.isFinite(until)) return
			const scoped = SCOPE[kind]
			const deadlines = scoped === 'pool' ? poolDeadlines : modelDeadlines
			const key = scoped === 'pool' ? target.pool : target.model
			const current = deadlines.get(key)
			if (current !== undefined && current >= until) return
			deadlines.set(key, until)
		},
		isCooling(target: CooldownTarget): boolean {
			return active(poolDeadlines, target.pool) || active(modelDeadlines, target.model)
		}
	}
}

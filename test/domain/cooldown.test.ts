import { describe, expect, test } from 'bun:test'
import { createPoolCooldowns, type CooldownKind, type CooldownTarget } from '../../src/domain/cooldown'
import type { CooldownSeconds } from '../../src/domain/config'

const SECONDS: CooldownSeconds = { rateLimit: 60, quota: 1800, transient: 30, poolUnavailable: 21600 }

/** Mutable injected clock: every tracker in these tests reads time from here. */
function fakeClock(start: number): { now: () => number; set: (value: number) => void } {
	let current = start
	return {
		now: () => current,
		set: (value: number) => {
			current = value
		}
	}
}

/** One mark target: the entry's pool plus its `provider/modelID`. Variants share the model key. */
const target = (pool: string, model: string): CooldownTarget => ({ pool, model })

describe('createPoolCooldowns', () => {
	test('maps every error kind to its configured cooldown duration', () => {
		const clock = fakeClock(1_000)
		const cooldowns = createPoolCooldowns(SECONDS, clock.now)
		const cases: Array<[CooldownKind, number]> = [
			['rate-limit', SECONDS.rateLimit],
			['quota', SECONDS.quota],
			['transient', SECONDS.transient],
			['pool-unavailable', SECONDS.poolUnavailable]
		]
		for (const [kind, seconds] of cases) {
			// A distinct pool per kind: a pool-scoped mark must not leak into the next case.
			const marked = target(`pool-${kind}`, `prov/${kind}`)
			clock.set(1_000)
			cooldowns.mark(kind, marked)
			// Cooling right up to (but not past) the deadline: expiry is exact.
			clock.set(1_000 + seconds * 1000 - 1)
			expect(cooldowns.isCooling(marked)).toBe(true)
			clock.set(1_000 + seconds * 1000)
			expect(cooldowns.isCooling(marked)).toBe(false)
		}
	})

	test('rate-limit and transient cool only the exact model, not its pool', () => {
		const clock = fakeClock(0)
		const cooldowns = createPoolCooldowns(SECONDS, clock.now)
		for (const kind of ['rate-limit', 'transient'] as const) {
			const model = target('prov', `prov/${kind}`)
			cooldowns.mark(kind, model)
			expect(cooldowns.isCooling(model)).toBe(true)
			// A pool-mate of the same provider stays eligible.
			expect(cooldowns.isCooling(target('prov', 'prov/pool-mate'))).toBe(false)
		}
	})

	test('quota and pool-unavailable cool the whole pool', () => {
		const clock = fakeClock(0)
		const cooldowns = createPoolCooldowns(SECONDS, clock.now)
		for (const kind of ['quota', 'pool-unavailable'] as const) {
			cooldowns.mark(kind, target('prov', `prov/${kind}`))
			// Every model of that pool reads as cooling, including ones never marked.
			expect(cooldowns.isCooling(target('prov', 'prov/never-marked'))).toBe(true)
		}
	})

	test('isCooling is true when either the pool or the model is cooling', () => {
		const clock = fakeClock(0)
		// Model side alone: the pool stays eligible.
		const modelSide = createPoolCooldowns(SECONDS, clock.now)
		modelSide.mark('rate-limit', target('prov', 'prov/a'))
		expect(modelSide.isCooling(target('prov', 'prov/a'))).toBe(true)
		expect(modelSide.isCooling(target('prov', 'prov/b'))).toBe(false)
		// Pool side alone: a model never marked is cooling with its pool.
		const poolSide = createPoolCooldowns(SECONDS, clock.now)
		poolSide.mark('quota', target('zen', 'zen/a'))
		expect(poolSide.isCooling(target('zen', 'zen/b'))).toBe(true)
	})

	test('never shortens an existing longer cooldown', () => {
		const clock = fakeClock(0)
		const cooldowns = createPoolCooldowns(SECONDS, clock.now)
		// Pool side: quota (1800s) must not shorten pool-unavailable (21600s).
		const pool = target('zen', 'zen/a')
		cooldowns.mark('pool-unavailable', pool)
		cooldowns.mark('quota', pool)
		clock.set(SECONDS.quota * 1000 + 1)
		expect(cooldowns.isCooling(pool)).toBe(true)
		clock.set(SECONDS.poolUnavailable * 1000 - 1)
		expect(cooldowns.isCooling(pool)).toBe(true)
		clock.set(SECONDS.poolUnavailable * 1000)
		expect(cooldowns.isCooling(pool)).toBe(false)

		// Model side: transient (30s) must not shorten rate-limit (60s).
		clock.set(0)
		const model = target('prov', 'prov/a')
		cooldowns.mark('rate-limit', model)
		cooldowns.mark('transient', model)
		clock.set(SECONDS.transient * 1000 + 1)
		expect(cooldowns.isCooling(model)).toBe(true)
		clock.set(SECONDS.rateLimit * 1000)
		expect(cooldowns.isCooling(model)).toBe(false)
	})

	test('extends an active cooldown when the new kind lasts longer', () => {
		const clock = fakeClock(0)
		// Pool side: pool-unavailable (21600s) extends quota (1800s).
		const poolCooldowns = createPoolCooldowns(SECONDS, clock.now)
		const pool = target('prov', 'prov/a')
		poolCooldowns.mark('quota', pool)
		poolCooldowns.mark('pool-unavailable', pool)
		clock.set(SECONDS.quota * 1000 + 1)
		expect(poolCooldowns.isCooling(pool)).toBe(true)
		clock.set(SECONDS.poolUnavailable * 1000)
		expect(poolCooldowns.isCooling(pool)).toBe(false)

		// Model side: a longer transient extends an active rate-limit.
		clock.set(0)
		const modelCooldowns = createPoolCooldowns({ ...SECONDS, transient: 120 }, clock.now)
		const model = target('prov', 'prov/b')
		modelCooldowns.mark('rate-limit', model)
		modelCooldowns.mark('transient', model)
		clock.set(SECONDS.rateLimit * 1000 + 1)
		expect(modelCooldowns.isCooling(model)).toBe(true)
		clock.set(120_000)
		expect(modelCooldowns.isCooling(model)).toBe(false)
	})

	test('zero-second cooldowns mean no cooldown', () => {
		const clock = fakeClock(0)
		const cooldowns = createPoolCooldowns({ ...SECONDS, rateLimit: 0, quota: 0 }, clock.now)
		const fresh = target('prov', 'prov/fresh')
		cooldowns.mark('rate-limit', fresh)
		expect(cooldowns.isCooling(fresh)).toBe(false)
		// A zero-duration mark must not wipe a longer active cooldown on the same key.
		const held = target('zen', 'zen/held')
		cooldowns.mark('pool-unavailable', held)
		cooldowns.mark('quota', held)
		clock.set(SECONDS.poolUnavailable * 1000 - 1)
		expect(cooldowns.isCooling(held)).toBe(true)
		clock.set(SECONDS.poolUnavailable * 1000)
		expect(cooldowns.isCooling(held)).toBe(false)
	})

	test('tracks pools and models independently', () => {
		const clock = fakeClock(0)
		const cooldowns = createPoolCooldowns(SECONDS, clock.now)
		cooldowns.mark('rate-limit', target('prov', 'prov/a'))
		expect(cooldowns.isCooling(target('prov', 'prov/a'))).toBe(true)
		expect(cooldowns.isCooling(target('prov', 'prov/b'))).toBe(false)
		expect(cooldowns.isCooling(target('other', 'other/a'))).toBe(false)
		expect(cooldowns.isCooling(target('prov', 'never/marked'))).toBe(false)

		cooldowns.mark('quota', target('other', 'other/a'))
		expect(cooldowns.isCooling(target('other', 'other/b'))).toBe(true)
		expect(cooldowns.isCooling(target('prov', 'prov/b'))).toBe(false)
	})

	test('an expired cooldown can be replaced by a fresh, shorter one', () => {
		const clock = fakeClock(0)
		const cooldowns = createPoolCooldowns(SECONDS, clock.now)
		const pool = target('prov', 'prov/a')
		cooldowns.mark('pool-unavailable', pool)
		clock.set(SECONDS.poolUnavailable * 1000)
		expect(cooldowns.isCooling(pool)).toBe(false)
		cooldowns.mark('quota', pool)
		expect(cooldowns.isCooling(pool)).toBe(true)
		clock.set(SECONDS.poolUnavailable * 1000 + SECONDS.quota * 1000)
		expect(cooldowns.isCooling(pool)).toBe(false)
	})

	test('a fresh failure restarts an active cooldown of the same kind', () => {
		const clock = fakeClock(0)
		const cooldowns = createPoolCooldowns(SECONDS, clock.now)
		const model = target('prov', 'prov/a')
		cooldowns.mark('rate-limit', model)
		clock.set(30_000)
		cooldowns.mark('rate-limit', model)
		clock.set(60_001)
		expect(cooldowns.isCooling(model)).toBe(true)
		clock.set(90_000)
		expect(cooldowns.isCooling(model)).toBe(false)
	})

	test('defaults to the wall clock when no clock is injected', () => {
		const cooldowns = createPoolCooldowns(SECONDS)
		const model = target('prov', 'prov/a')
		cooldowns.mark('transient', model)
		expect(cooldowns.isCooling(model)).toBe(true)
	})
})

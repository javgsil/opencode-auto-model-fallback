import { describe, expect, test } from 'bun:test'
import { selectNextEntry, type FailingIdentity } from '../../src/domain/selection'
import type { ChainEntry } from '../../src/domain/config'

const M1: ChainEntry = { model: 'prov/m1' }
const M2: ChainEntry = { model: 'prov/m2' }
const M3: ChainEntry = { model: 'prov/m3' }
const M1_HIGH: ChainEntry = { model: 'prov/m1', variant: 'high' }

const failing = (providerID: string, modelID: string, variant?: string): FailingIdentity =>
	variant === undefined ? { providerID, modelID } : { providerID, modelID, variant }

describe('selectNextEntry', () => {
	test('returns the first entry when the failing model is not in the chain', () => {
		expect(selectNextEntry([M1, M2], failing('other', 'gpt'), [])).toEqual(M1)
	})

	test('continues after the position of the failing entry when it is in the chain', () => {
		expect(selectNextEntry([M1, M2, M3], failing('prov', 'm1'), [])).toEqual(M2)
		expect(selectNextEntry([M1, M2, M3], failing('prov', 'm2'), [M2])).toEqual(M3)
	})

	test('never returns the failing entry itself even when it appears twice', () => {
		const chain = [M2, M1, M3, M1]
		// Continues after the FIRST identical position; the later duplicate is skipped by identity.
		expect(selectNextEntry(chain, failing('prov', 'm1'), [])).toEqual(M3)
	})

	test('never returns an entry that was already attempted', () => {
		const chain = [M1, M2, M3]
		expect(selectNextEntry(chain, failing('other', 'gpt'), [M1, M2])).toEqual(M3)
		expect(selectNextEntry(chain, failing('other', 'gpt'), [M1, M2, M3])).toBeNull()
	})

	test('treats variant as part of the identity', () => {
		const chain: ChainEntry[] = [M1_HIGH, M2]
		// A default-variant failure of prov/m1 is not identical to the high-variant entry.
		expect(selectNextEntry(chain, failing('prov', 'm1'), [])).toEqual(M1_HIGH)
		// A high-variant failure matches the entry exactly and continues after it.
		expect(selectNextEntry(chain, failing('prov', 'm1', 'high'), [])).toEqual(M2)
	})

	test('returns null when the chain is empty or exhausted', () => {
		expect(selectNextEntry([], failing('prov', 'm1'), [])).toBeNull()
		expect(selectNextEntry([M1, M2], failing('prov', 'm2'), [M1])).toBeNull()
		expect(selectNextEntry([M1], failing('prov', 'm1'), [])).toBeNull()
	})

	test('the position rule wins over unattempted entries before the failing entry', () => {
		expect(selectNextEntry([M1, M2, M3], failing('prov', 'm3'), [M1])).toBeNull()
		expect(selectNextEntry([M1, M2, M3], failing('prov', 'm2'), [M1])).toEqual(M3)
	})

	test('is deterministic for repeated calls with the same inputs', () => {
		const chain = [M1, M2, M3]
		const first = selectNextEntry(chain, failing('other', 'gpt'), [M1])
		for (let i = 0; i < 3; i++) {
			expect(selectNextEntry(chain, failing('other', 'gpt'), [M1])).toEqual(first)
		}
		expect(first).toEqual(M2)
	})

	test('does not mutate the chain or the attempted list', () => {
		const chain = [M1, M2]
		const attempted = [M1]
		selectNextEntry(chain, failing('prov', 'm2'), attempted)
		expect(chain).toEqual([M1, M2])
		expect(attempted).toEqual([M1])
	})

	test('skips entries the availability predicate rejects', () => {
		const chain = [M1, M2, M3]
		expect(selectNextEntry(chain, failing('prov', 'm1'), [], (entry) => entry !== M2)).toEqual(M3)
		expect(selectNextEntry(chain, failing('prov', 'm1'), [], (entry) => entry !== M2 && entry !== M3)).toBeNull()
	})

	test('offers candidates to the predicate in chain order until one is available', () => {
		const seen: ChainEntry[] = []
		const next = selectNextEntry([M1, M2, M3], failing('prov', 'm1'), [], (entry) => {
			seen.push(entry)
			return entry === M3
		})
		// M2 is rejected first, so the predicate runs again for M3; evaluation stops there.
		expect(seen).toEqual([M2, M3])
		expect(next).toEqual(M3)
	})

	test('the position and attempted rules still win when a predicate is given', () => {
		const chain = [M1, M2, M3]
		// M1 is available but sits before the failing entry's position; M3 is rejected.
		expect(selectNextEntry(chain, failing('prov', 'm2'), [M1], (entry) => entry !== M3)).toBeNull()
	})

	test('behaves identically to the no-predicate form when everything is available', () => {
		const chain = [M1, M2, M3]
		const all = (entry: ChainEntry): boolean => {
			void entry
			return true
		}
		expect(selectNextEntry(chain, failing('prov', 'm1'), [M1], all)).toEqual(
			selectNextEntry(chain, failing('prov', 'm1'), [M1])
		)
		expect(selectNextEntry([], failing('prov', 'm1'), [], all)).toBeNull()
	})
})

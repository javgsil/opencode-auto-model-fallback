/**
 * Pure next-entry selection for a fallback chain. No I/O, no state: the caller
 * supplies the chain, the identity of the model that just failed, and the
 * entries already attempted for the current user request.
 */

import type { ChainEntry } from './config'

/** Identity of the model that failed for one request. */
export type FailingIdentity = {
	providerID: string
	modelID: string
	/** Absent means the model's default variant. */
	variant?: string
}

function modelRef(identity: FailingIdentity): string {
	return `${identity.providerID}/${identity.modelID}`
}

/** Identity equality: both model ref and variant must match. */
function sameIdentity(entry: ChainEntry, identity: FailingIdentity): boolean {
	return entry.model === modelRef(identity) && entry.variant === identity.variant
}

function sameEntry(a: ChainEntry, b: ChainEntry): boolean {
	return a.model === b.model && a.variant === b.variant
}

/**
 * Next chain entry to try, or `null` when the chain is exhausted.
 *
 * Rules (deterministic, order-preserving):
 * - never an entry identical (model + variant) to the failing one;
 * - never an entry already attempted for this request;
 * - when the failing identity sits in the chain, continue after its position;
 * - otherwise start from the beginning of the chain.
 */
export function selectNextEntry(
	chain: readonly ChainEntry[],
	failing: FailingIdentity,
	attempted: readonly ChainEntry[]
): ChainEntry | null {
	const failingIndex = chain.findIndex((entry) => sameIdentity(entry, failing))
	const start = failingIndex === -1 ? 0 : failingIndex + 1
	for (let index = start; index < chain.length; index++) {
		const entry = chain[index]
		if (entry === undefined) continue
		if (sameIdentity(entry, failing)) continue
		if (attempted.some((attempt) => sameEntry(attempt, entry))) continue
		return entry
	}
	return null
}

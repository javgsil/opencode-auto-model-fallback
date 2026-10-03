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
 * Optional availability check for a candidate entry, e.g. "its pool is not
 * cooling down". Returning `false` skips the entry as if it had been attempted.
 */
export type Availability = (entry: ChainEntry) => boolean

/**
 * Next chain entry to try, or `null` when the chain is exhausted.
 *
 * Rules (deterministic, order-preserving):
 * - never an entry identical (model + variant) to the failing one;
 * - never an entry already attempted for this request;
 * - never an entry the availability predicate rejects;
 * - when the failing identity sits in the chain, continue after its position;
 * - otherwise start from the beginning of the chain.
 *
 * The predicate defaults to "every entry is available", so callers without
 * availability concerns keep the original behavior.
 */
export function selectNextEntry(
	chain: readonly ChainEntry[],
	failing: FailingIdentity,
	attempted: readonly ChainEntry[],
	isAvailable: Availability = () => true
): ChainEntry | null {
	const failingIndex = chain.findIndex((entry) => sameIdentity(entry, failing))
	const start = failingIndex === -1 ? 0 : failingIndex + 1
	for (let index = start; index < chain.length; index++) {
		const entry = chain[index]
		if (entry === undefined) continue
		if (sameIdentity(entry, failing)) continue
		if (attempted.some((attempt) => sameEntry(attempt, entry))) continue
		if (!isAvailable(entry)) continue
		return entry
	}
	return null
}

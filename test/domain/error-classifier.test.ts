import { describe, expect, test } from 'bun:test'
import { classifyError, ERROR_PATTERN_TABLE, type ErrorClass } from '../../src/domain/error-classifier'

const GLOBAL_REGIONS =
	"Upstream request failed: This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it."

const isKind = (actual: ErrorClass, kind: ErrorClass['kind']): boolean => actual.kind === kind

describe('classifyError', () => {
	test('classifies quota exhaustion', () => {
		expect(classifyError({ message: 'You have exceeded your usage limit' }).kind).toBe('quota')
		expect(classifyError({ message: 'quota exceeded for this billing period' }).kind).toBe('quota')
		expect(classifyError({ message: 'credit balance too low' }).kind).toBe('quota')
		expect(classifyError({ message: 'insufficient_quota' }).kind).toBe('quota')
	})

	test('classifies rate limits', () => {
		expect(classifyError({ statusCode: 429 }).kind).toBe('rate-limit')
		expect(classifyError({ message: 'Rate limit exceeded, retry later' }).kind).toBe('rate-limit')
		expect(classifyError({ message: 'too many requests' }).kind).toBe('rate-limit')
		expect(classifyError({ message: 'rate_limit_error' }).kind).toBe('rate-limit')
	})

	test('classifies pool-unavailable including the verbatim Global regions error', () => {
		expect(classifyError({ message: GLOBAL_REGIONS, providerID: 'opencode-go' }).kind).toBe('pool-unavailable')
		expect(classifyError({ message: 'model not available in your region' }).kind).toBe('pool-unavailable')
		expect(classifyError({ statusCode: 401 }).kind).toBe('pool-unavailable')
		expect(classifyError({ statusCode: 403 }).kind).toBe('pool-unavailable')
		expect(classifyError({ message: 'model not found' }).kind).toBe('pool-unavailable')
		expect(classifyError({ message: 'this model is not supported by the provider' }).kind).toBe('pool-unavailable')
	})

	test('classifies transient server failures', () => {
		for (const statusCode of [500, 502, 503, 504, 529]) {
			expect(classifyError({ statusCode }).kind).toBe('transient')
		}
		expect(classifyError({ message: 'upstream overloaded' }).kind).toBe('transient')
		expect(classifyError({ message: 'service unavailable' }).kind).toBe('transient')
	})

	test('keeps benign billing notices and aborts out of the fallback path', () => {
		expect(classifyError({ message: 'not your plan limits' }).kind).toBe('not-fallback')
		expect(classifyError({ message: 'we will draw from your extra usage' }).kind).toBe('not-fallback')
		expect(classifyError({ message: 'user aborted the request' }).kind).toBe('not-fallback')
		expect(classifyError({ message: 'some unrelated failure' }).kind).toBe('not-fallback')
		expect(classifyError({}).kind).toBe('not-fallback')
		expect(classifyError({ message: undefined, statusCode: undefined }).kind).toBe('not-fallback')
	})

	test('applies pool-unavailable over quota over rate-limit over transient', () => {
		expect(classifyError({ message: 'requires Global regions', statusCode: 429 }).kind).toBe('pool-unavailable')
		expect(classifyError({ message: 'requires Global regions', statusCode: 500 }).kind).toBe('pool-unavailable')
		expect(classifyError({ message: 'insufficient_quota', statusCode: 429 }).kind).toBe('quota')
		expect(classifyError({ message: 'usage limit reached', statusCode: 502 }).kind).toBe('quota')
		expect(classifyError({ message: 'rate limit exceeded', statusCode: 503 }).kind).toBe('rate-limit')
		expect(classifyError({ message: 'overloaded', statusCode: 429 }).kind).toBe('rate-limit')
		expect(classifyError({ message: 'service unavailable', statusCode: 403 }).kind).toBe('pool-unavailable')
	})

	test('matches case-insensitively', () => {
		expect(classifyError({ message: 'RATE LIMIT EXCEEDED' }).kind).toBe('rate-limit')
		expect(classifyError({ message: 'This Model Requires GLOBAL Regions.' }).kind).toBe('pool-unavailable')
		expect(classifyError({ message: 'Insufficient_Quota' }).kind).toBe('quota')
	})

	test('exports one pattern table covering every non-terminal class', () => {
		expect(Object.keys(ERROR_PATTERN_TABLE).sort()).toEqual(['pool-unavailable', 'quota', 'rate-limit', 'transient'])
		for (const rule of Object.values(ERROR_PATTERN_TABLE)) {
			expect(rule.patterns.length).toBeGreaterThan(0)
		}
		expect(isKind(classifyError({ statusCode: 404 }), 'not-fallback')).toBe(true)
	})
})

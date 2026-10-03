import { describe, expect, test } from 'bun:test'
import type { Hooks, Plugin } from '@opencode-ai/plugin'
import { createHooks } from '../../src/runtime/hooks'

type Client = Parameters<Plugin>[0]['client']
type EventInput = Parameters<NonNullable<Hooks['event']>>[0]
type ChatMessageOutput = Parameters<NonNullable<Hooks['chat.message']>>[1]
type ChatParamsInput = Parameters<NonNullable<Hooks['chat.params']>>[0]
type ChatParamsOutput = Parameters<NonNullable<Hooks['chat.params']>>[1]
type AssistantInfo = Extract<
	Extract<EventInput['event'], { type: 'message.updated' }>['properties']['info'],
	{ role: 'assistant' }
>

type LogBody = { service?: unknown; level?: unknown; message?: unknown; extra?: unknown }
type PromptCall = { path?: { id?: string }; body?: Record<string, unknown> }

const FAKE_CONFIG_PATH = '/fake/agent-fallback.json'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function userMessage(sessionID: string, id = `msg_user_${sessionID}`): ChatMessageOutput['message'] {
	return {
		id,
		sessionID,
		role: 'user',
		time: { created: 1 },
		agent: 'coder',
		model: { providerID: 'prov', modelID: 'm1' }
	}
}

function textPart(sessionID: string, text: string): ChatMessageOutput['parts'][number] {
	return { id: `part_${text}`, sessionID, messageID: `msg_user_${sessionID}`, type: 'text', text }
}

function paramsInput(sessionID: string, agent: string, providerID: string, modelID: string): ChatParamsInput {
	return {
		sessionID,
		agent,
		model: { providerID, id: modelID } as unknown as ChatParamsInput['model'],
		provider: { source: 'config', info: {}, options: {} } as unknown as ChatParamsInput['provider'],
		message: userMessage(sessionID)
	}
}

function paramsOutput(): ChatParamsOutput {
	return { temperature: 0.7, topP: 1, topK: 40, maxOutputTokens: undefined, options: {} }
}

function assistantFailure(fields: Record<string, unknown>): AssistantInfo {
	return fields as unknown as AssistantInfo
}

const apiError = (message: string, statusCode?: number) => ({
	name: 'APIError',
	data: statusCode === undefined ? { message, isRetryable: false } : { message, statusCode, isRetryable: false }
})

/** The verbatim work-subscription error opencode retries forever (T0 spike, opencode 1.18.34). */
const GLOBAL_REGIONS =
	"Upstream request failed: This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it."

type Fixture = {
	hooks: Hooks
	logCalls: LogBody[]
	prompts: PromptCall[]
	/** Session ids passed to `client.session.abort`, in call order. */
	aborts: string[]
	/** Order of resend/abort calls: `prompt:<sessionID>` and `abort:<sessionID>`. */
	trace: string[]
	releasePrompts: () => void
	/** Release one deferred prompt by its index in `prompts`, so completions can be reordered. */
	releasePrompt: (promptIndex: number) => void
}

async function makeHooks(
	options: {
		configJson?: string | null
		agentsData?: unknown
		hasAgentsApi?: boolean
		sessionErrorGraceMs?: number
		rejectPrompt?: boolean
		rejectLog?: boolean
		rejectAbort?: boolean
		deferPrompt?: boolean
		/** Injectable clock for the pool-cooldown tracker (tests). */
		now?: () => number
	} = {}
): Promise<Fixture> {
	const configJson =
		options.configJson === undefined ? '{"default":["prov/m1","prov/m2","prov/m3"]}' : options.configJson
	const logCalls: LogBody[] = []
	const prompts: PromptCall[] = []
	const aborts: string[] = []
	const trace: string[] = []
	const held: Array<{ promptIndex: number; resolve: () => void }> = []
	const app: Record<string, unknown> = {}
	if (options.hasAgentsApi !== false) app.agents = async () => ({ data: options.agentsData ?? [{ name: 'coder' }] })
	app.log = async (call: { body?: LogBody }) => {
		if (options.rejectLog) throw new Error('log transport down')
		if (call.body) logCalls.push(call.body)
		return true
	}
	const client = {
		app,
		session: {
			promptAsync: async (call: PromptCall) => {
				const promptIndex = prompts.push(call) - 1
				trace.push(`prompt:${call.path?.id ?? ''}`)
				if (options.rejectPrompt) throw new Error('prompt transport down')
				if (options.deferPrompt === true) await new Promise<void>((resolve) => held.push({ promptIndex, resolve }))
				return {}
			},
			abort: async (call: { path?: { id?: string } }) => {
				if (options.rejectAbort) throw new Error('abort transport down')
				const id = call.path?.id ?? ''
				aborts.push(id)
				trace.push(`abort:${id}`)
				return {}
			}
		}
	} as unknown as Client

	const hooks = await createHooks({
		client,
		projectDirectory: '/project',
		configLoader: {
			env: (key) => (key === 'OPENCODE_AGENT_FALLBACK_CONFIG' ? FAKE_CONFIG_PATH : undefined),
			homedir: () => '/home/user',
			exists: (path) => path === FAKE_CONFIG_PATH && configJson !== null,
			read: () => configJson ?? '{}'
		},
		sessionErrorGraceMs: options.sessionErrorGraceMs ?? 5,
		...(options.now === undefined ? {} : { now: options.now })
	})
	return {
		hooks,
		logCalls,
		prompts,
		aborts,
		trace,
		releasePrompts: () => held.splice(0).forEach((entry) => entry.resolve()),
		releasePrompt: (promptIndex: number) => {
			const at = held.findIndex((entry) => entry.promptIndex === promptIndex)
			if (at === -1) throw new Error(`prompt ${promptIndex} is not held`)
			const [entry] = held.splice(at, 1)
			entry?.resolve()
		}
	}
}

async function captureRequest(
	hooks: Hooks,
	sessionID: string,
	agent: string,
	providerID: string,
	modelID: string,
	text = 'hello'
): Promise<void> {
	await hooks['chat.message']!(
		{ sessionID, agent },
		{ message: userMessage(sessionID), parts: [textPart(sessionID, text)] }
	)
	await hooks['chat.params']!(paramsInput(sessionID, agent, providerID, modelID), paramsOutput())
}

function emitFailure(
	hooks: Hooks,
	sessionID: string,
	id: string,
	providerID: string,
	modelID: string,
	agent: string,
	error: unknown,
	variant?: string,
	parentID?: string
): Promise<void> {
	return hooks.event!({
		event: {
			type: 'message.updated',
			properties: {
				info: assistantFailure({
					id,
					sessionID,
					role: 'assistant',
					providerID,
					modelID,
					agent,
					...(variant === undefined ? {} : { variant }),
					...(parentID === undefined ? {} : { parentID }),
					error
				})
			}
		}
	})
}

/** Assistant `message.updated` without an error: proof the model produced output for this request. */
function emitAssistantUpdate(
	hooks: Hooks,
	sessionID: string,
	id: string,
	providerID: string,
	modelID: string,
	parentID?: string
): Promise<void> {
	return hooks.event!({
		event: {
			type: 'message.updated',
			properties: {
				info: assistantFailure({
					id,
					sessionID,
					role: 'assistant',
					providerID,
					modelID,
					agent: 'coder',
					...(parentID === undefined ? {} : { parentID })
				})
			}
		}
	})
}

/** The exact user message id the resend at `index` passed to `promptAsync`. */
function resendMessageID(prompts: PromptCall[], index: number): string {
	const id = prompts[index]?.body?.messageID
	if (typeof id !== 'string') throw new Error(`resend ${index} carries no messageID`)
	return id
}

/** A `session.status` retry event: the host announcing it is retrying the live model. */
function emitRetry(hooks: Hooks, sessionID: string, message: string, attempt = 1): Promise<void> {
	return hooks.event!({
		event: {
			type: 'session.status',
			properties: { sessionID, status: { type: 'retry', attempt, message, next: 1000 } }
		}
	})
}

async function emitResendEcho(
	hooks: Hooks,
	sessionID: string,
	prompts: PromptCall[],
	index: number,
	text = 'hello'
): Promise<void> {
	await hooks['chat.message']!(
		{ sessionID },
		{ message: userMessage(sessionID, resendMessageID(prompts, index)), parts: [textPart(sessionID, text)] }
	)
}

describe('fallback resend', () => {
	test('resends with explicit agent, next model and the original user parts', async () => {
		const { hooks, prompts, logCalls } = await makeHooks({ configJson: '{"agents":{"coder":["prov/c1","prov/c2"]}}' })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'c1')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'c1', 'coder', apiError('rate limit exceeded', 429))

		expect(prompts).toHaveLength(1)
		const call = prompts[0]!
		expect(call.path).toEqual({ id: 's1' })
		expect(call.body?.agent).toBe('coder')
		expect(call.body?.model).toEqual({ providerID: 'prov', modelID: 'c2' })
		expect(call.body?.variant).toBeUndefined()
		expect(call.body?.parts).toEqual([{ type: 'text', text: 'hello' }])
		expect(logCalls.every((body) => body.service === 'opencode-agent-fallback')).toBe(true)
	})

	test('sends the chain entry variant when one is defined and omits it otherwise', async () => {
		// quota cools the whole pool, so this same-pool resend needs quota disabled in the fixture.
		const { hooks, prompts } = await makeHooks({
			configJson: '{"agents":{"coder":[{"model":"prov/v1","variant":"high"},"prov/v2"]},"cooldownSeconds":{"quota":0}}'
		})
		await captureRequest(hooks, 's1', 'coder', 'prov', 'v1', 'go')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'v1', 'coder', apiError('quota exceeded'), 'high')
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'prov', modelID: 'v2' })
		expect('variant' in (prompts[0]?.body ?? {})).toBe(false)

		const second = await makeHooks({ configJson: '{"default":[{"model":"prov/v1","variant":"high"}]}' })
		await captureRequest(second.hooks, 's2', 'coder', 'prov', 'other')
		await emitFailure(second.hooks, 's2', 'msg_b', 'prov', 'other', 'coder', apiError('rate limit', 429))
		expect(second.prompts).toHaveLength(1)
		expect(second.prompts[0]?.body?.variant).toBe('high')
	})

	test('handles each failed assistant message at most once', async () => {
		const { hooks, prompts } = await makeHooks()
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		const failure = () => emitFailure(hooks, 's1', 'msg_dup', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		await failure()
		await failure()
		await failure()
		expect(prompts).toHaveLength(1)
	})

	test('walks the chain once per user request and stops with a single exhaustion log', async () => {
		const { hooks, prompts, logCalls } = await makeHooks()
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm2' })

		// The echo of our own resend must not reset the per-request chain.
		await emitResendEcho(hooks, 's1', prompts, 0)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm2'), paramsOutput())
		await emitFailure(hooks, 's1', 'msg_b', 'prov', 'm2', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm3' })

		await emitResendEcho(hooks, 's1', prompts, 1)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm3'), paramsOutput())
		await emitFailure(hooks, 's1', 'msg_c', 'prov', 'm3', 'coder', apiError('rate limit', 429))
		await emitFailure(hooks, 's1', 'msg_d', 'prov', 'm3', 'coder', apiError('rate limit', 429))

		expect(prompts).toHaveLength(2)
		const exhaustion = logCalls.filter((body) => String(body.message).includes('exhausted'))
		expect(exhaustion).toHaveLength(1)
		expect(exhaustion[0]?.level).toBe('warn')
	})

	test('an echo chat.message does not reset attempted entries for the same request', async () => {
		const { hooks, prompts } = await makeHooks({ configJson: '{"default":[{"model":"prov/m2","variant":"high"}]}' })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.variant).toBe('high')

		// Echo of our resend: same user parts, then its params.
		await emitResendEcho(hooks, 's1', prompts, 0)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm2'), paramsOutput())

		// Only a session-level failure with a non-identical captured identity can fire now.
		await sleep(150)
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await sleep(30)
		expect(prompts).toHaveLength(1)
	})

	test('a variant-changing resend records the live variant so a later session error continues forward', async () => {
		const { hooks, prompts } = await makeHooks({
			configJson: '{"agents":{"coder":["prov/a","prov/b",{"model":"prov/c","variant":"high"},"prov/d"]}}',
			sessionErrorGraceMs: 5
		})
		await captureRequest(hooks, 's1', 'coder', 'prov', 'b')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'b', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'prov', modelID: 'c' })
		expect(prompts[0]?.body?.variant).toBe('high')

		// Echo of that resend: chat.message is ignored, chat.params only refreshes agent/provider/model.
		await emitResendEcho(hooks, 's1', prompts, 0)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'c'), paramsOutput())

		// A session-only failure while the high-variant model is running: it must be
		// attributed to prov/c@high so selection continues forward to prov/d.
		await sleep(150)
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await sleep(30)
		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.body?.model).toEqual({ providerID: 'prov', modelID: 'd' })
	})

	test('a resend to a default-variant entry clears the live variant', async () => {
		const { hooks, prompts } = await makeHooks({
			configJson: '{"agents":{"coder":["prov/a","prov/b",{"model":"prov/c","variant":"high"},"prov/d"]}}',
			sessionErrorGraceMs: 5
		})
		await hooks['chat.message']!(
			{ sessionID: 's1', agent: 'coder', variant: 'high' },
			{ message: userMessage('s1'), parts: [textPart('s1', 'hello')] }
		)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'c'), paramsOutput())
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'c', 'coder', apiError('rate limit', 429), 'high')
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'prov', modelID: 'd' })
		expect('variant' in (prompts[0]?.body ?? {})).toBe(false)

		await emitResendEcho(hooks, 's1', prompts, 0)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'd'), paramsOutput())

		// prov/d is the last chain entry: the session error must be attributed to the
		// default variant of prov/d (exhausted), not restart the chain at prov/a.
		await sleep(150)
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await sleep(30)
		expect(prompts).toHaveLength(1)
	})

	test('an assistant failure without variant metadata is attributed to the live variant of the same model', async () => {
		const { hooks, prompts } = await makeHooks({
			configJson: '{"agents":{"coder":["prov/a",{"model":"prov/b","variant":"high"},"prov/c"]}}'
		})
		// The request runs the high variant of the second chain entry.
		await hooks['chat.message']!(
			{ sessionID: 's1', agent: 'coder', variant: 'high' },
			{ message: userMessage('s1'), parts: [textPart('s1', 'hello')] }
		)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'b'), paramsOutput())

		// The installed AssistantMessage type carries no variant field, so this failure of
		// prov/b@high arrives bare: selection must continue to prov/c, not restart at prov/a.
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'b', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'prov', modelID: 'c' })
		expect('variant' in (prompts[0]?.body ?? {})).toBe(false)
	})

	test('a failure from a model other than the live one does not borrow the live variant', async () => {
		const { hooks, prompts } = await makeHooks({
			configJson: '{"agents":{"coder":["prov/a",{"model":"prov/b","variant":"high"},"prov/c"]}}'
		})
		await hooks['chat.message']!(
			{ sessionID: 's1', agent: 'coder', variant: 'high' },
			{ message: userMessage('s1'), parts: [textPart('s1', 'hello')] }
		)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'b'), paramsOutput())

		// prov/c@default is the last chain entry, so the chain is exhausted. Borrowing the
		// live high variant would make prov/c look absent from the chain and restart at prov/a.
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'c', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(0)
	})
})

describe('cross-request failure correlation', () => {
	test('ignores a delayed assistant failure whose parent is a previous request user message', async () => {
		const { hooks, prompts } = await makeHooks()
		await hooks['chat.message']!(
			{ sessionID: 's1', agent: 'coder' },
			{ message: userMessage('s1', 'msg_u1'), parts: [textPart('s1', 'first')] }
		)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm1'), paramsOutput())
		await hooks['chat.message']!(
			{ sessionID: 's1', agent: 'coder' },
			{ message: userMessage('s1', 'msg_u2'), parts: [textPart('s1', 'second')] }
		)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm1'), paramsOutput())

		// Repeated failure of the FIRST request's assistant: it must not resend the
		// second request's parts.
		await emitFailure(hooks, 's1', 'msg_stale', 'prov', 'm1', 'coder', apiError('rate limit', 429), undefined, 'msg_u1')
		expect(prompts).toHaveLength(0)

		// The live request's own failure is still correlated and resends normally.
		await emitFailure(hooks, 's1', 'msg_ok', 'prov', 'm1', 'coder', apiError('rate limit', 429), undefined, 'msg_u2')
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm2' })
	})

	test('still walks the chain when the failure parent is this request, resend echo included', async () => {
		const { hooks, prompts } = await makeHooks()
		await hooks['chat.message']!(
			{ sessionID: 's1', agent: 'coder' },
			{ message: userMessage('s1', 'msg_u1'), parts: [textPart('s1', 'hello')] }
		)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm1'), paramsOutput())
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429), undefined, 'msg_u1')
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm2' })

		// Echo user message of our own resend, then the params it triggers.
		const echoID = resendMessageID(prompts, 0)
		await emitResendEcho(hooks, 's1', prompts, 0)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm2'), paramsOutput())

		// The echo's assistant reply points at the echo user message: still our request.
		await emitFailure(hooks, 's1', 'msg_b', 'prov', 'm2', 'coder', apiError('rate limit', 429), undefined, echoID)
		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm3' })
	})
})

describe('never falls back', () => {
	test('on not-fallback errors', async () => {
		const { hooks, prompts } = await makeHooks()
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', {
			name: 'UnknownError',
			data: { message: 'weird business rule' }
		})
		expect(prompts).toHaveLength(0)
	})

	test('on aborts', async () => {
		const { hooks, prompts } = await makeHooks()
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', {
			name: 'MessageAbortedError',
			data: { message: 'Aborted' }
		})
		expect(prompts).toHaveLength(0)
	})

	test('when the plugin is disabled', async () => {
		const { hooks, prompts } = await makeHooks({ configJson: '{"enabled":false,"default":["prov/m1","prov/m2"]}' })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(0)
	})

	test('when no user parts were captured', async () => {
		const { hooks, prompts, logCalls } = await makeHooks()
		await hooks['chat.message']!({ sessionID: 's1', agent: 'coder' }, { message: userMessage('s1'), parts: [] })
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm1'), paramsOutput())
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(0)
		expect(logCalls.some((body) => String(body.message).includes('no user message parts'))).toBe(true)
	})

	test('for an agent whose explicitly configured chain is empty, even when a default chain exists', async () => {
		const { hooks, prompts, logCalls } = await makeHooks({
			configJson: '{"agents":{"coder":[]},"default":["prov/m1","prov/m2"]}'
		})
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(0)
		// An empty chain means "no fallback", not "chain exhausted".
		expect(logCalls.some((body) => String(body.message).includes('exhausted'))).toBe(false)
	})

	test('for a non-assistant message.updated event', async () => {
		const { hooks, prompts } = await makeHooks()
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await hooks.event!({
			event: {
				type: 'message.updated',
				properties: {
					info: {
						id: 'msg_user_update',
						sessionID: 's1',
						role: 'user',
						time: { created: 1 },
						agent: 'coder',
						model: { providerID: 'prov', modelID: 'm1' }
					}
				}
			}
		})
		expect(prompts).toHaveLength(0)
	})
})

describe('session.error correlation', () => {
	test('falls back from session.error when identity is captured, without double-sending on the twin message', async () => {
		const { hooks, prompts } = await makeHooks({ sessionErrorGraceMs: 8 })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await sleep(25)
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm2' })

		// The assistant message for the same failure arrives afterwards: it must not resend.
		await emitFailure(hooks, 's1', 'msg_twin', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)
	})

	test('lets the twin message.updated win when it arrives before the grace timer', async () => {
		const { hooks, prompts } = await makeHooks({ sessionErrorGraceMs: 40 })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await sleep(5)
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)
		await sleep(60)
		expect(prompts).toHaveLength(1)
	})

	test('does not fire a stale session.error timer after the twin message failure already resent', async () => {
		const { hooks, prompts } = await makeHooks({ sessionErrorGraceMs: 40 })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		// Before the grace period expires: the twin failure, then the echo of its resend and the new params.
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		await emitResendEcho(hooks, 's1', prompts, 0)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm2'), paramsOutput())
		await sleep(60)
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm2' })
	})

	test('skips a pending session.error once chat.params moved the session to another model', async () => {
		const { hooks, prompts } = await makeHooks({ sessionErrorGraceMs: 40 })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		// The session error is bound to prov/m1; by fire time the live model is prov/m2.
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm2'), paramsOutput())
		await sleep(60)
		expect(prompts).toHaveLength(0)
	})

	test('ignores session.error without a captured identity', async () => {
		const { hooks, prompts } = await makeHooks({ sessionErrorGraceMs: 5 })
		await hooks['chat.message']!(
			{ sessionID: 's1', agent: 'coder' },
			{ message: userMessage('s1'), parts: [textPart('s1', 'hi')] }
		)
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await sleep(25)
		expect(prompts).toHaveLength(0)
	})

	test('ignores aborts and not-fallback session errors', async () => {
		const { hooks, prompts } = await makeHooks({ sessionErrorGraceMs: 5 })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: { sessionID: 's1', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } }
			}
		})
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: { sessionID: 's1', error: { name: 'UnknownError', data: { message: 'odd failure' } } }
			}
		})
		await sleep(25)
		expect(prompts).toHaveLength(0)
	})

	test('derives the failing modelID from the chat.params model id', async () => {
		const { hooks, prompts } = await makeHooks({ configJson: '{"default":["prov/m1","prov/m2"]}' })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'prov/m1')
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await sleep(25)
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm2' })
	})

	test('a session error for a different model inside the twin window still advances the chain', async () => {
		const { hooks, prompts } = await makeHooks()
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)

		// The resend's echo and params move the session to prov/m2.
		await emitResendEcho(hooks, 's1', prompts, 0)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm2'), paramsOutput())

		// No sleep: this arrives well inside the 100ms twin window of the prov/m1 failure.
		// prov/m2 has already produced output for this request (the assistant update below),
		// so this is a new failure of prov/m2, not a twin of prov/m1's.
		await emitAssistantUpdate(hooks, 's1', 'msg_ran', 'prov', 'm2', resendMessageID(prompts, 0))
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await sleep(25)
		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm3' })
	})

	test('a late session.error twin of the previous failure does not start a second resend', async () => {
		const { hooks, prompts } = await makeHooks()
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)

		// The resend's echo and params move the session to prov/m2 and clear pendingResend.
		await emitResendEcho(hooks, 's1', prompts, 0)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm2'), paramsOutput())

		// A's session.error twin arrives only after that. It carries no model identity and
		// nothing shows prov/m2 produced output, so it must not be read as prov/m2's failure.
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await sleep(25)
		expect(prompts).toHaveLength(1)
	})
})

describe('robustness', () => {
	test('never throws when the resend call rejects and logs the failure', async () => {
		const { hooks, logCalls } = await makeHooks({ rejectPrompt: true })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(logCalls.some((body) => body.level === 'error' && String(body.message).includes('resend failed'))).toBe(true)
	})

	test('never throws when the log transport itself rejects', async () => {
		const { hooks, prompts } = await makeHooks({ rejectLog: true })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)
	})

	test('drops session state on session.deleted', async () => {
		const { hooks, prompts } = await makeHooks({ sessionErrorGraceMs: 5 })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await hooks.event!({ event: { type: 'session.deleted', properties: { info: { id: 's1' } as never } } })
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await sleep(25)
		expect(prompts).toHaveLength(0)
	})

	test('dispose cancels pending session.error timers', async () => {
		const { hooks, prompts } = await makeHooks({ sessionErrorGraceMs: 5 })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await hooks.dispose!()
		await sleep(25)
		expect(prompts).toHaveLength(0)
	})
})

describe('init validation and config reporting', () => {
	test('warns for configured agents missing from client.app.agents()', async () => {
		const { logCalls } = await makeHooks({
			agentsData: [{ name: 'coder' }],
			configJson: '{"agents":{"coder":[],"typo-agent":[]}}'
		})
		const unknown = logCalls.filter((body) => String(body.message).includes('unknown agent'))
		expect(unknown).toHaveLength(1)
		expect(String(unknown[0]?.message)).toContain('typo-agent')
		expect(unknown[0]?.level).toBe('warn')
	})

	test('falls back to the config hook agent map when app.agents is unavailable', async () => {
		const { hooks, logCalls } = await makeHooks({
			hasAgentsApi: false,
			configJson: '{"agents":{"coder":[],"typo-agent":[]}}'
		})
		await hooks.config!({ agent: { coder: {} } })
		const unknown = logCalls.filter((body) => String(body.message).includes('unknown agent'))
		expect(unknown).toHaveLength(1)
		expect(String(unknown[0]?.message)).toContain('typo-agent')
	})

	test('degrades silently to no validation when no source is available', async () => {
		const { hooks, logCalls } = await makeHooks({ hasAgentsApi: false, configJson: '{"agents":{"typo-agent":[]}}' })
		await hooks.config!({})
		expect(logCalls.filter((body) => String(body.message).includes('unknown agent'))).toHaveLength(0)
	})

	test('reports config issues through client.app.log with the service name', async () => {
		const { logCalls } = await makeHooks({ configJson: '{broken json' })
		const errors = logCalls.filter((body) => body.level === 'error' && String(body.message).includes('invalid JSON'))
		expect(errors).toHaveLength(1)
		expect(errors[0]?.service).toBe('opencode-agent-fallback')
		expect(String(errors[0]?.message)).toContain(FAKE_CONFIG_PATH)
	})
})

describe('resend echo correlation', () => {
	test('a genuine request arriving before the resend params restarts the chain with its own parts', async () => {
		const { hooks, prompts } = await makeHooks()
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1', 'hello')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)

		// A genuine user message with different text, while the resend is still outstanding.
		await hooks['chat.message']!(
			{ sessionID: 's1', agent: 'coder' },
			{ message: userMessage('s1', 'msg_g'), parts: [textPart('s1', 'second')] }
		)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm1'), paramsOutput())

		// Its own failure resends only its own parts, walking a fresh chain.
		await emitFailure(hooks, 's1', 'msg_b', 'prov', 'm1', 'coder', apiError('rate limit', 429), undefined, 'msg_g')
		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.body?.parts).toEqual([{ type: 'text', text: 'second' }])
		expect(prompts[1]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm2' })
	})

	test('a resend resolving after a newer genuine request does not overwrite its identity', async () => {
		const { hooks, prompts, releasePrompts } = await makeHooks({ deferPrompt: true })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1', 'hello')
		const resend = emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		for (let i = 0; i < 200 && prompts.length === 0; i++) await sleep(1)
		expect(prompts).toHaveLength(1)

		// A newer genuine request starts while the resend call is still in flight.
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1', 'fresh')
		releasePrompts()
		await resend

		// The live identity stays the newer request's, so a later session-level failure
		// resends its parts from the fresh chain instead of continuing the stale one.
		await sleep(150)
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await sleep(30)
		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm2' })
		expect(prompts[1]?.body?.parts).toEqual([{ type: 'text', text: 'fresh' }])
	})

	test('the echo carrying the resend messageID does not reset the chain', async () => {
		const { hooks, prompts } = await makeHooks()
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1', 'hello')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)
		const echoID = resendMessageID(prompts, 0)
		await emitResendEcho(hooks, 's1', prompts, 0)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm2'), paramsOutput())
		await emitFailure(hooks, 's1', 'msg_b', 'prov', 'm2', 'coder', apiError('rate limit', 429), undefined, echoID)
		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm3' })
	})

	test('a resend completing after a later resend does not restore the failed identity', async () => {
		const { hooks, prompts, releasePrompt } = await makeHooks({
			configJson: '{"default":["prov/m1","prov/m2","prov/m3","prov/m4"]}',
			sessionErrorGraceMs: 5,
			deferPrompt: true
		})
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')

		// m1 fails: the resend selecting prov/m2 stays in flight.
		const failM1 = emitFailure(hooks, 's1', 'msg_a', 'prov', 'm1', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)

		// B's echo and params make prov/m2 the live identity...
		await emitResendEcho(hooks, 's1', prompts, 0)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm2'), paramsOutput())

		// ...and B's own failure resends prov/m3, also still in flight.
		const failM2 = emitFailure(hooks, 's1', 'msg_b', 'prov', 'm2', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(2)
		await emitResendEcho(hooks, 's1', prompts, 1)
		await hooks['chat.params']!(paramsInput('s1', 'coder', 'prov', 'm3'), paramsOutput())

		// Out-of-order completion: prov/m3's call resolves first, prov/m2's stale one after it.
		releasePrompt(1)
		await failM2
		releasePrompt(0)
		await failM1

		// Evidence that prov/m3 actually ran for this request...
		await emitAssistantUpdate(hooks, 's1', 'msg_ok', 'prov', 'm3', resendMessageID(prompts, 1))

		// ...then a session-only failure: it must be attributed to prov/m3, not to the
		// already-failed prov/m2 that the stale completion tried to restore.
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'APIError', data: { message: 'rate limit', statusCode: 429, isRetryable: true } }
				}
			}
		})
		await sleep(30)
		expect(prompts).toHaveLength(3)
		expect(prompts[2]?.body?.model).toEqual({ providerID: 'prov', modelID: 'm4' })
	})
})

describe('pool cooldowns', () => {
	test('skips every entry of the cooled pool and resends to the next pool', async () => {
		const { hooks, prompts } = await makeHooks({ configJson: '{"default":["go/a","go/b","zen/c"]}' })
		await captureRequest(hooks, 's1', 'coder', 'go', 'a')
		await emitFailure(hooks, 's1', 'msg_a', 'go', 'a', 'coder', apiError(GLOBAL_REGIONS))
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'zen', modelID: 'c' })
	})

	test('honors pool mappings so one provider cools its whole mapped pool', async () => {
		const { hooks, prompts } = await makeHooks({
			configJson: '{"default":["opencode-go/a","zen/b","other/c"],"pools":{"opencode-go":"opencode","zen":"opencode"}}'
		})
		await captureRequest(hooks, 's1', 'coder', 'opencode-go', 'a')
		await emitFailure(hooks, 's1', 'msg_a', 'opencode-go', 'a', 'coder', apiError(GLOBAL_REGIONS))
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'other', modelID: 'c' })
	})

	test('a pool cooled by one session stays cooled for another session', async () => {
		const { hooks, prompts } = await makeHooks({ configJson: '{"default":["go/a","go/b","zen/c"]}' })
		// Session 1 cools pool "go" and resends to zen/c.
		await captureRequest(hooks, 's1', 'coder', 'go', 'a')
		await emitFailure(hooks, 's1', 'msg_a', 'go', 'a', 'coder', apiError(GLOBAL_REGIONS))
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'zen', modelID: 'c' })

		// Session 2 fails in the same pool: go/b must still be skipped, so zen/c wins again.
		await captureRequest(hooks, 's2', 'coder', 'go', 'a')
		await emitFailure(hooks, 's2', 'msg_b', 'go', 'a', 'coder', apiError(GLOBAL_REGIONS))
		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.body?.model).toEqual({ providerID: 'zen', modelID: 'c' })
	})

	test('expires a pool cooldown once the configured duration passes', async () => {
		const clock = { value: 1_000_000 }
		const { hooks, prompts } = await makeHooks({
			configJson: '{"default":["go/a","zen/x","go/b"]}',
			now: () => clock.value
		})
		// Session 1 cools pool "go" (deadline 1_000_000 + 21_600_000) and resends to zen/x.
		await captureRequest(hooks, 's1', 'coder', 'go', 'a')
		await emitFailure(hooks, 's1', 'msg_a', 'go', 'a', 'coder', apiError(GLOBAL_REGIONS))
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'zen', modelID: 'x' })

		// Session 2 runs zen/x: go/b is still cooling, so nothing is left to try.
		await captureRequest(hooks, 's2', 'coder', 'zen', 'x')
		await emitFailure(hooks, 's2', 'msg_b', 'zen', 'x', 'coder', apiError(GLOBAL_REGIONS))
		expect(prompts).toHaveLength(1)

		// Step one millisecond past the go deadline.
		clock.value += 21_600_001

		// Session 3: pool "go" is eligible again, so go/b must be selectable.
		await captureRequest(hooks, 's3', 'coder', 'zen', 'x')
		await emitFailure(hooks, 's3', 'msg_c', 'zen', 'x', 'coder', apiError(GLOBAL_REGIONS))
		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.body?.model).toEqual({ providerID: 'go', modelID: 'b' })
	})

	test('logs once when every remaining entry is cooling down', async () => {
		const { hooks, prompts, logCalls } = await makeHooks({ configJson: '{"default":["go/a","go/b"]}' })
		await captureRequest(hooks, 's1', 'coder', 'go', 'a')
		await emitFailure(hooks, 's1', 'msg_a', 'go', 'a', 'coder', apiError(GLOBAL_REGIONS))
		expect(prompts).toHaveLength(0)

		// A second distinct failure of the same request must not log again.
		await emitFailure(hooks, 's1', 'msg_b', 'go', 'b', 'coder', apiError(GLOBAL_REGIONS))
		expect(prompts).toHaveLength(0)
		const cooling = logCalls.filter((body) => String(body.message).includes('cooling'))
		expect(cooling).toHaveLength(1)
		expect(cooling[0]?.level).toBe('warn')
	})
})

describe('session.status retries', () => {
	test('aborts the stuck retry and resends to the next pool when the pool is unavailable', async () => {
		const { hooks, prompts, aborts } = await makeHooks({ configJson: '{"default":["go/a","go/b","zen/c"]}' })
		await captureRequest(hooks, 's1', 'coder', 'go', 'a')
		await emitRetry(hooks, 's1', GLOBAL_REGIONS)
		expect(aborts).toEqual(['s1'])
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'zen', modelID: 'c' })
	})

	test('stops the host retry loop before the resend is issued', async () => {
		const { hooks, trace } = await makeHooks({ configJson: '{"default":["go/a","zen/c"]}' })
		await captureRequest(hooks, 's1', 'coder', 'go', 'a')
		await emitRetry(hooks, 's1', GLOBAL_REGIONS)
		expect(trace).toEqual(['abort:s1', 'prompt:s1'])
	})

	test('acts only once when the host keeps reporting the same retry', async () => {
		const { hooks, prompts, aborts } = await makeHooks({ configJson: '{"default":["go/a","zen/c"]}' })
		await captureRequest(hooks, 's1', 'coder', 'go', 'a')
		await emitRetry(hooks, 's1', GLOBAL_REGIONS, 1)
		await emitRetry(hooks, 's1', GLOBAL_REGIONS, 2)
		await emitRetry(hooks, 's1', GLOBAL_REGIONS, 3)
		expect(aborts).toEqual(['s1'])
		expect(prompts).toHaveLength(1)
	})

	test('aborts without a resend when every remaining entry is cooling down', async () => {
		const { hooks, prompts, aborts, logCalls } = await makeHooks({ configJson: '{"default":["go/a","go/b"]}' })
		await captureRequest(hooks, 's1', 'coder', 'go', 'a')
		await emitRetry(hooks, 's1', GLOBAL_REGIONS)
		expect(aborts).toEqual(['s1'])
		expect(prompts).toHaveLength(0)
		const cooling = logCalls.filter((body) => String(body.message).includes('cooling'))
		expect(cooling).toHaveLength(1)
		expect(cooling[0]?.level).toBe('warn')
	})

	test('does not abort a rate-limited retry when the chain has no next entry', async () => {
		const { hooks, prompts, aborts } = await makeHooks({ configJson: '{"default":["prov/m1"]}' })
		await captureRequest(hooks, 's1', 'coder', 'prov', 'm1')
		await emitRetry(hooks, 's1', 'rate limit exceeded')
		expect(aborts).toHaveLength(0)
		expect(prompts).toHaveLength(0)
	})

	test('ignores retries while the plugin is disabled', async () => {
		const { hooks, prompts, aborts } = await makeHooks({ configJson: '{"enabled":false,"default":["go/a","zen/c"]}' })
		await captureRequest(hooks, 's1', 'coder', 'go', 'a')
		await emitRetry(hooks, 's1', GLOBAL_REGIONS)
		expect(aborts).toHaveLength(0)
		expect(prompts).toHaveLength(0)
	})

	test('the abort follow-up MessageAbortedError does not trigger another fallback', async () => {
		const { hooks, prompts, aborts } = await makeHooks({ configJson: '{"default":["go/a","zen/c"]}' })
		await captureRequest(hooks, 's1', 'coder', 'go', 'a')
		await emitRetry(hooks, 's1', GLOBAL_REGIONS)
		expect(aborts).toEqual(['s1'])
		expect(prompts).toHaveLength(1)

		// The aborted generation surfaces as a session.error follow-up: no extra abort or resend.
		await hooks.event!({
			event: {
				type: 'session.error',
				properties: { sessionID: 's1', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } }
			}
		})
		expect(aborts).toEqual(['s1'])
		expect(prompts).toHaveLength(1)
	})
})

describe('cooldown scope by error kind', () => {
	test('a rate-limited model cools alone: resend stays in the pool and a second session skips only that model', async () => {
		const { hooks, prompts } = await makeHooks({ configJson: '{"default":["prov/a","prov/b"]}' })
		// Session 1: prov/a is rate-limited; its pool-mate prov/b must take over.
		await captureRequest(hooks, 's1', 'coder', 'prov', 'a')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'a', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'prov', modelID: 'b' })

		// Session 2: a fresh chain walk from the top: prov/a still cools (shared tracker),
		// prov/b of the same pool stays eligible.
		await captureRequest(hooks, 's2', 'coder', 'other', 'z')
		await emitFailure(hooks, 's2', 'msg_b', 'other', 'z', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.body?.model).toEqual({ providerID: 'prov', modelID: 'b' })
	})

	test('a quota failure cools the whole pool: go/b is skipped in favor of zen/c', async () => {
		const { hooks, prompts } = await makeHooks({ configJson: '{"default":["go/a","go/b","zen/c"]}' })
		await captureRequest(hooks, 's1', 'coder', 'go', 'a')
		await emitFailure(hooks, 's1', 'msg_a', 'go', 'a', 'coder', apiError('quota exceeded'))
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'zen', modelID: 'c' })
	})

	test('a model cooldown expires on its own while the pool stays usable', async () => {
		const clock = { value: 1_000_000 }
		const { hooks, prompts } = await makeHooks({
			configJson: '{"default":["prov/a","other/x"],"cooldownSeconds":{"rateLimit":60}}',
			now: () => clock.value
		})
		// Session 1: rate-limited prov/a cools only that model; other/x takes over.
		await captureRequest(hooks, 's1', 'coder', 'prov', 'a')
		await emitFailure(hooks, 's1', 'msg_a', 'prov', 'a', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'other', modelID: 'x' })

		// Session 2: prov/a still cooling (deadline 1_060_000), other/x eligible again.
		await captureRequest(hooks, 's2', 'coder', 'other', 'z')
		await emitFailure(hooks, 's2', 'msg_b', 'other', 'z', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(2)
		expect(prompts[1]?.body?.model).toEqual({ providerID: 'other', modelID: 'x' })

		// Step one millisecond past the model deadline.
		clock.value += 60_001

		// Session 3: prov/a is eligible again, so the walk starts with it.
		await captureRequest(hooks, 's3', 'coder', 'other', 'z')
		await emitFailure(hooks, 's3', 'msg_c', 'other', 'z', 'coder', apiError('rate limit', 429))
		expect(prompts).toHaveLength(3)
		expect(prompts[2]?.body?.model).toEqual({ providerID: 'prov', modelID: 'a' })
	})
})

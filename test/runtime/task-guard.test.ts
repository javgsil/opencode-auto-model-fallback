import { describe, expect, test } from 'bun:test'
import type { Hooks, Plugin } from '@opencode-ai/plugin'
import { createTaskGuard, type TaskGuardOptions } from '../../src/runtime/task-guard'
import type { Logger } from '../../src/runtime/log'

type Client = Parameters<Plugin>[0]['client']
type TransformHandler = NonNullable<Hooks['experimental.chat.messages.transform']>
type TransformOutput = Parameters<TransformHandler>[1]

type Fields = Record<string, unknown>

const PARENT = 'ses_parent'
const CHILD = 'ses_child'

/* ------------------------------------------------------------- fixtures */

function taskPart(statePatch: Fields = {}, partPatch: Fields = {}): Fields {
	return {
		id: 'prt_1',
		sessionID: PARENT,
		messageID: 'msg_1',
		type: 'tool',
		callID: 'call_1',
		tool: 'task',
		state: {
			status: 'error',
			input: { description: 'ping', prompt: 'Reply with exactly: CHILD-OK', subagent_type: 'spike-child' },
			error: 'Task cancelled',
			metadata: {
				parentSessionId: PARENT,
				sessionId: CHILD,
				model: { providerID: 'opencode', modelID: 'deepseek-v4.1-flash' }
			},
			time: { start: 1000, end: 1040 },
			...statePatch
		},
		...partPatch
	}
}

function stateOf(part: Fields): Fields {
	const state = part.state
	if (typeof state !== 'object' || state === null) throw new Error('part carries no state')
	return state as Fields
}

function transformOutput(parts: Fields[], info: Fields = {}): TransformOutput {
	return {
		messages: [{ info: { id: 'msg_1', role: 'assistant', sessionID: PARENT, ...info }, parts }]
	} as unknown as TransformOutput
}

/** A child session turn: the user prompt plus the assistant answer (or none yet). */
function childTurn(text: string | undefined, info: Fields = {}, extraParts: Fields[] = []): Fields[] {
	return [
		{
			info: { id: 'msg_c0', role: 'user', sessionID: CHILD, time: { created: 1 } },
			parts: [{ type: 'text', text: 'Reply with exactly: CHILD-OK' }]
		},
		{
			info: { id: 'msg_c1', role: 'assistant', sessionID: CHILD, time: { created: 2 }, ...info },
			parts: [...(text === undefined ? [] : [{ type: 'text', text }]), ...extraParts]
		}
	]
}

/** A tool part of a child turn that has not finished yet. */
function childToolPart(status: 'pending' | 'running'): Fields {
	return {
		id: 'prt_child_tool',
		sessionID: CHILD,
		messageID: 'msg_c1',
		type: 'tool',
		callID: 'call_child_tool',
		tool: 'bash',
		state:
			status === 'pending'
				? { status: 'pending', input: {}, raw: '' }
				: { status: 'running', input: {}, time: { start: 5 } }
	}
}

const idle = (childID: string): Fields => ({ [childID]: { type: 'idle' } })
const busy = (childID: string): Fields => ({ [childID]: { type: 'busy' } })

type PromptCall = { path?: { id?: string }; body?: Fields; signal?: AbortSignal }
type Behaviour = {
	status?: (n: number) => unknown
	messages?: (childID: string, n: number) => unknown
	promptAsync?: (call: PromptCall) => unknown
}

function makeClient(behaviour: Behaviour = {}): {
	client: Client
	prompts: PromptCall[]
	calls: () => { status: number; messages: number }
} {
	let statusCalls = 0
	let messageCalls = 0
	const prompts: PromptCall[] = []
	const client = {
		session: {
			status: async () => {
				statusCalls += 1
				return behaviour.status?.(statusCalls) ?? { data: {} }
			},
			messages: async (call: { path?: { id?: string } }) => {
				messageCalls += 1
				return behaviour.messages?.(call.path?.id ?? '', messageCalls) ?? { data: [] }
			},
			promptAsync: async (call: PromptCall) => {
				prompts.push(call)
				return behaviour.promptAsync?.(call) ?? {}
			}
		}
	} as unknown as Client
	return { client, prompts, calls: () => ({ status: statusCalls, messages: messageCalls }) }
}

function makeLogger(): { logger: Logger; entries: Fields[]; of: (level: string) => Fields[] } {
	const entries: Fields[] = []
	const push = (level: string) => (message: string) => {
		entries.push({ level, message })
	}
	const logger: Logger = {
		debug: push('debug'),
		info: push('info'),
		warn: push('warn'),
		error: push('error')
	}
	return {
		logger,
		entries,
		of: (level: string) => entries.filter((entry) => entry.level === level)
	}
}

/** Fake clock: `sleep` advances virtual time, so waits never cost real time. */
function makeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
	let time = 0
	return {
		now: () => time,
		sleep: async (ms: number) => {
			time += ms
		}
	}
}

function setup(
	behaviour: Behaviour = {},
	overrides: Partial<TaskGuardOptions> = {}
): {
	guard: TransformHandler
	prompts: PromptCall[]
	calls: () => { status: number; messages: number }
	of: (level: string) => Fields[]
} {
	const { client, prompts, calls } = makeClient(behaviour)
	const { logger, of } = makeLogger()
	const clock = makeClock()
	const guard = createTaskGuard({
		client: overrides.client ?? client,
		logger: overrides.logger ?? logger,
		timeoutMs: overrides.timeoutMs ?? 5000,
		resendInterruptedChild: overrides.resendInterruptedChild ?? true,
		now: overrides.now ?? clock.now,
		sleep: overrides.sleep ?? clock.sleep
	})
	return { guard, prompts, calls, of }
}

/** Child answers on the third poll, like the orphan observed in the spike. */
const answerOnThirdPoll: Behaviour = {
	status: (n) => ({ data: n <= 2 ? busy(CHILD) : idle(CHILD) }),
	messages: (_childID, n) => ({
		data: n <= 2 ? childTurn(undefined) : childTurn('CHILD-OK', { finish: 'stop' })
	})
}

/* ---------------------------------------------------------------- tests */

describe('task guard: recovery', () => {
	test('replaces the phantom error with the child answer once the orphan finishes', async () => {
		const { guard, calls, of } = setup(answerOnThirdPoll)
		const part = taskPart()

		await guard({}, transformOutput([part]))

		const state = stateOf(part)
		expect(state.status).toBe('completed')
		expect(state.output).toBe('CHILD-OK')
		expect(state.title).toBe('ping')
		expect(state.metadata).toEqual({
			parentSessionId: PARENT,
			sessionId: CHILD,
			model: { providerID: 'opencode', modelID: 'deepseek-v4.1-flash' }
		})
		expect(state.time).toEqual({ start: 1000, end: 1040 })
		expect('error' in state).toBe(false)
		expect(calls().status).toBe(3)
		expect(of('info').some((entry) => String(entry.message).includes(CHILD))).toBe(true)
	})

	test('caches the outcome so a later transform never polls again', async () => {
		const { guard, calls } = setup(answerOnThirdPoll)

		await guard({}, transformOutput([taskPart()]))
		const afterFirst = calls()

		const later = taskPart()
		await guard({}, transformOutput([later]))

		expect(calls()).toEqual(afterFirst)
		expect(stateOf(later).status).toBe('completed')
		expect(stateOf(later).output).toBe('CHILD-OK')
	})

	test('concurrent transform calls share one in-flight wait', async () => {
		const { guard, calls } = setup(answerOnThirdPoll)
		const first = taskPart({}, { id: 'prt_a', callID: 'call_a' })
		const second = taskPart({}, { id: 'prt_b', callID: 'call_a' })

		await Promise.all([guard({}, transformOutput([first])), guard({}, transformOutput([second]))])

		expect(calls()).toEqual({ status: 3, messages: 3 })
		expect(stateOf(first).output).toBe('CHILD-OK')
		expect(stateOf(second).output).toBe('CHILD-OK')
	})

	test('scopes cached outcomes to the owning part so equal call ids never share an answer', async () => {
		const childA = 'ses_child_a'
		const childB = 'ses_child_b'
		const { guard } = setup({
			status: () => ({ data: { [childA]: { type: 'idle' }, [childB]: { type: 'idle' } } }),
			messages: (childID) => ({
				data: childTurn(childID === childA ? 'ANSWER-A' : 'ANSWER-B', { finish: 'stop' })
			})
		})
		const first = taskPart(
			{ metadata: { parentSessionId: 'ses_parent_a', sessionId: childA } },
			{ sessionID: 'ses_parent_a', callID: 'call_same' }
		)
		const second = taskPart(
			{ metadata: { parentSessionId: 'ses_parent_b', sessionId: childB } },
			{ sessionID: 'ses_parent_b', callID: 'call_same' }
		)

		await guard({}, transformOutput([first]))
		await guard({}, transformOutput([second]))

		expect(stateOf(first).output).toBe('ANSWER-A')
		expect(stateOf(second).output).toBe('ANSWER-B')
	})
})

describe('task guard: intermediate answer recovery', () => {
	test('recovers the final stop answer, not preliminary text of a busy tool-calls turn', async () => {
		const { guard } = setup({
			status: (n) => ({ data: n <= 2 ? busy(CHILD) : idle(CHILD) }),
			messages: (_childID, n) => ({
				data: n <= 2 ? childTurn('PRELIMINARY', { finish: 'tool-calls' }) : childTurn('CHILD-OK', { finish: 'stop' })
			})
		})
		const part = taskPart()

		await guard({}, transformOutput([part]))

		const state = stateOf(part)
		expect(state.status).toBe('completed')
		expect(state.output).toBe('CHILD-OK')
	})

	test('never recovers a tool-calls turn as the final answer, even while the child is idle', async () => {
		const { guard, prompts } = setup({
			status: () => ({ data: idle(CHILD) }),
			messages: () => ({ data: childTurn('PRELIMINARY', { finish: 'tool-calls' }) })
		})
		const part = taskPart()

		await guard({}, transformOutput([part]))

		const state = stateOf(part)
		expect(state.status).toBe('error')
		expect(String(state.error)).toContain(CHILD)
		expect(prompts).toHaveLength(1)
	})

	test('does not recover a finished turn while the child is still running', async () => {
		const { guard, prompts } = setup(
			{
				status: () => ({ data: busy(CHILD) }),
				messages: () => ({ data: childTurn('CHILD-OK', { finish: 'stop' }) })
			},
			{ timeoutMs: 3000 }
		)
		const part = taskPart()

		await guard({}, transformOutput([part]))

		const state = stateOf(part)
		expect(state.status).toBe('error')
		expect(String(state.error)).toContain(CHILD)
		expect(prompts).toHaveLength(0)
	})

	for (const toolStatus of ['pending', 'running'] as const) {
		test(`does not recover a terminal-finish turn while its ${toolStatus} tool part is outstanding`, async () => {
			const { guard } = setup(
				{
					status: () => ({ data: idle(CHILD) }),
					messages: () => ({ data: childTurn('CHILD-OK', { finish: 'stop' }, [childToolPart(toolStatus)]) })
				},
				{ timeoutMs: 3000 }
			)
			const part = taskPart()

			await guard({}, transformOutput([part]))

			const state = stateOf(part)
			expect(state.status).toBe('error')
			expect(String(state.error)).toContain(CHILD)
		})
	}
})

describe('task guard: interrupted child', () => {
	test('resumes an idle child exactly once with the task agent and model, then recovers', async () => {
		const { guard, prompts, calls } = setup(
			{
				status: () => ({ data: idle(CHILD) }),
				// Still unanswered on the polls after the resume prompt, so a second
				// resume would be observable as a second `promptAsync` call.
				messages: (_childID, n) => ({
					data: n <= 5 ? childTurn(undefined) : childTurn('CHILD-OK', { finish: 'stop' })
				})
			},
			{ timeoutMs: 20000 }
		)
		const part = taskPart()

		await guard({}, transformOutput([part]))

		expect(prompts).toHaveLength(1)
		expect(prompts[0]?.path?.id).toBe(CHILD)
		expect(prompts[0]?.body?.agent).toBe('spike-child')
		expect(prompts[0]?.body?.model).toEqual({ providerID: 'opencode', modelID: 'deepseek-v4.1-flash' })
		expect(prompts[0]?.body?.parts).toEqual([{ type: 'text', text: 'Reply with exactly: CHILD-OK' }])
		expect(calls().status).toBeGreaterThanOrEqual(6)
		expect(stateOf(part).status).toBe('completed')
		expect(stateOf(part).output).toBe('CHILD-OK')
	})

	test('never resumes a child whose message reads keep failing while status reports idle', async () => {
		const { guard, prompts, of } = setup(
			{
				status: () => ({ data: idle(CHILD) }),
				// An SDK-shaped failure carries no `data`: it is a failed inspection, not an
				// empty history, so it must never be read as "the child never answered".
				messages: () => ({ error: { name: 'X' } })
			},
			{ timeoutMs: 3000 }
		)
		const part = taskPart()

		await guard({}, transformOutput([part]))

		expect(prompts).toHaveLength(0)
		expect(of('debug').some((entry) => String(entry.message).includes(CHILD))).toBe(true)
		const state = stateOf(part)
		expect(state.status).toBe('error')
		expect(String(state.error)).toContain(CHILD)
		expect(String(state.error)).toMatch(/no final answer|timeout/i)
	})

	test('never resumes from a failed status read, which must not count as idle', async () => {
		const { guard, prompts } = setup(
			{
				status: () => ({ error: { name: 'X' } }),
				messages: () => ({ data: childTurn(undefined) })
			},
			{ timeoutMs: 3000 }
		)
		const part = taskPart()

		await guard({}, transformOutput([part]))

		expect(prompts).toHaveLength(0)
		const state = stateOf(part)
		expect(state.status).toBe('error')
		expect(String(state.error)).toContain(CHILD)
	})
})

describe('task guard: failure paths', () => {
	test('explains the timeout with the child id and logs a warning', async () => {
		const { guard, prompts, of } = setup(
			{
				status: () => ({ data: busy(CHILD) }),
				messages: () => ({ data: childTurn(undefined) })
			},
			{ timeoutMs: 3000 }
		)
		const part = taskPart()

		await guard({}, transformOutput([part]))

		const state = stateOf(part)
		expect(state.status).toBe('error')
		expect(String(state.error)).toContain(CHILD)
		expect(String(state.error)).toMatch(/retry/i)
		expect(String(state.error)).toContain('Task cancelled')
		expect(prompts).toHaveLength(0)
		expect(of('warn').some((entry) => String(entry.message).includes(CHILD))).toBe(true)
	})

	test('leaves non-task and non-phantom parts untouched', async () => {
		const { guard, calls } = setup()
		const wrongTool = taskPart({}, { callID: 'call_bash', tool: 'bash' })
		const wrongError = taskPart({ error: 'boom' }, { callID: 'call_boom' })
		const alreadyCompleted = taskPart({ status: 'completed' }, { callID: 'call_done' })
		const text = { id: 'prt_t', type: 'text', text: 'Task cancelled' }

		await guard({}, transformOutput([wrongTool, wrongError, alreadyCompleted, text]))

		expect(calls()).toEqual({ status: 0, messages: 0 })
		expect(stateOf(wrongTool).error).toBe('Task cancelled')
		expect(stateOf(wrongError).error).toBe('boom')
		expect(stateOf(alreadyCompleted).status).toBe('completed')
	})

	test('never touches a part whose parent assistant message was genuinely aborted', async () => {
		const { guard, calls } = setup(answerOnThirdPoll)
		const part = taskPart()

		await guard({}, transformOutput([part], { error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } }))

		expect(calls()).toEqual({ status: 0, messages: 0 })
		expect(stateOf(part).error).toBe('Task cancelled')
	})

	test('never throws when every client call fails, and still explains with the child id', async () => {
		const failing: Behaviour = {
			status: () => {
				throw new Error('transport down')
			},
			messages: () => {
				throw new Error('transport down')
			}
		}
		const { guard, of } = setup(failing, { timeoutMs: 2000 })
		const part = taskPart()

		await guard({}, transformOutput([part]))

		const state = stateOf(part)
		expect(state.status).toBe('error')
		expect(String(state.error)).toContain(CHILD)
		expect(of('warn').length + of('error').length).toBeGreaterThan(0)
	})

	test('leaves the part alone when the part carries no child session id', async () => {
		const { guard, calls, of } = setup(answerOnThirdPoll)
		const part = taskPart({ metadata: undefined })

		await guard({}, transformOutput([part]))

		expect(calls()).toEqual({ status: 0, messages: 0 })
		expect(stateOf(part).error).toBe('Task cancelled')
		expect(of('warn').length).toBeGreaterThan(0)
	})
})

describe('task guard: stalled client calls', () => {
	const stalled: Record<string, { behaviour: Behaviour; timeoutMs: number; promptCalls: number }> = {
		'session.status': { behaviour: { status: () => new Promise(() => {}) }, timeoutMs: 3000, promptCalls: 0 },
		'session.messages': {
			behaviour: { status: () => ({ data: busy(CHILD) }), messages: () => new Promise(() => {}) },
			timeoutMs: 3000,
			promptCalls: 0
		},
		'resume promptAsync': {
			behaviour: {
				status: () => ({ data: idle(CHILD) }),
				messages: () => ({ data: childTurn(undefined) }),
				promptAsync: () => new Promise(() => {})
			},
			timeoutMs: 5000,
			promptCalls: 1
		}
	}
	for (const [name, spec] of Object.entries(stalled)) {
		test(`bounds a never-settling ${name} by the deadline, then explains with the child id`, async () => {
			const { guard, prompts } = setup(spec.behaviour, { timeoutMs: spec.timeoutMs })
			const part = taskPart()

			await guard({}, transformOutput([part]))

			expect(prompts).toHaveLength(spec.promptCalls)
			// The bounded resume request must have been cancelled through its own AbortSignal.
			if (spec.promptCalls === 1) expect(prompts[0]?.signal?.aborted).toBe(true)
			const state = stateOf(part)
			expect(state.status).toBe('error')
			expect(String(state.error)).toContain(CHILD)
			expect(String(state.error)).toMatch(/timeout/i)
		}, 2000)
	}
})

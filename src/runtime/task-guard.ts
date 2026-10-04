/**
 * Phantom `Task cancelled` guard (opencode #45556).
 *
 * The `task` tool sometimes fails with `Error("Task cancelled")` tens of
 * milliseconds after it started while the child subagent session keeps running
 * as an orphan. `tool.execute.after` never fires on that path, so
 * `experimental.chat.messages.transform` — which fires for every LLM call of
 * every session and can mutate `part.state` in place — is the only place that
 * can still show the model the child's real answer (evidence: spike T0, see
 * `spike/plugin/spike.ts` and `spike/log.jsonl`).
 *
 * The handler keys on a `task` tool part in `error` state whose error matches
 * the phantom cancel, waits for the orphaned child to finish within a bounded
 * budget, and rewrites the part into a completed one. It never throws and
 * never blocks longer than the configured budget: the transform hook runs
 * inside the parent's generation.
 */

import type { Hooks, Plugin } from '@opencode-ai/plugin'
import type { Logger } from './log'

type Client = Parameters<Plugin>[0]['client']
type TransformHandler = NonNullable<Hooks['experimental.chat.messages.transform']>
type TransformOutput = Parameters<TransformHandler>[1]
type MessageEntry = TransformOutput['messages'][number]
type Part = MessageEntry['parts'][number]
type AssistantInfo = Extract<MessageEntry['info'], { role: 'assistant' }>
type AssistantEntry = { info: AssistantInfo; parts: Part[] }
type ToolPart = Extract<Part, { type: 'tool' }>
type ErrorState = Extract<ToolPart['state'], { status: 'error' }>
type CompletedState = Extract<ToolPart['state'], { status: 'completed' }>
/** A `task` tool part that carries the phantom cancel error. */
type PhantomPart = Omit<ToolPart, 'state'> & { state: ErrorState }

/** The exact error string the phantom cancel writes into the task part. */
const PHANTOM_CANCEL = /task cancelled/i

/** Poll cadence while waiting for the orphaned child. */
const POLL_MS = 1000

/**
 * Minimum age of the wait before an idle child may be prompted. The spike used
 * 1500ms for the same purpose (`resendDelayMs` default in `spike/plugin/spike.ts`),
 * because the child needs a moment to start its first turn after the task tool
 * spawned it; prompting earlier could race that turn.
 */
const RESEND_GRACE_MS = 1500

/** Bound on cached outcomes so a long-lived plugin cannot grow the map forever. */
const MAX_CACHED_OUTCOMES = 500

/** Microtask turns an awaited client call gets before its deadline timer is armed. */
const SETTLE_YIELD = 10

/** Raised when a bounded client call outlives the remaining deadline. */
class DeadlineExceededError extends Error {
	constructor(remainingMs: number) {
		super(`client call exceeded the remaining ${Math.max(0, Math.round(remainingMs))}ms deadline`)
		this.name = 'DeadlineExceededError'
	}
}

const DEFAULT_RESUME_TEXT = 'Continue and finish the task.'

/** Child liveness as reported by `GET /session/status`; `unknown` when it is not listed. */
type ChildStatus = 'idle' | 'busy' | 'retry' | 'unknown'

export type TaskGuardOutcome =
	/** The child finished; the part becomes a completed tool state carrying `text`. */
	| { kind: 'recovered'; text: string }
	/** No answer in time; the part keeps its error state but gets an explanation. */
	| { kind: 'explained'; childID: string; reason: string }
	/** Nothing safe to do: the part is left exactly as it is. */
	| { kind: 'unchanged' }

export type TaskGuardOptions = {
	client: Client
	logger: Logger
	/** Hard budget for one phantom part, in milliseconds. */
	timeoutMs: number
	/** Prompt an idle child without a final answer exactly once. */
	resendInterruptedChild: boolean
	/** Injectable clock and sleep so tests are deterministic and instant. */
	now?: () => number
	sleep?: (ms: number) => Promise<void>
}

function readString(value: unknown, key: string): string | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const found: unknown = (value as Record<string, unknown>)[key]
	return typeof found === 'string' ? found : undefined
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message
	if (typeof error === 'object' && error !== null) {
		const record = error as Record<string, unknown>
		if (typeof record.name === 'string') return record.name
		if (typeof record.message === 'string') return record.message
	}
	return String(error)
}

/** Only the phantom cancel counts; every other task failure is left alone. */
function isPhantomTaskPart(part: Part): part is PhantomPart {
	if (part.type !== 'tool') return false
	if (part.tool !== 'task') return false
	const state = part.state
	if (state.status !== 'error') return false
	return PHANTOM_CANCEL.test(state.error)
}

/**
 * A genuine user abort of the parent is never "recovered". The abort is carried
 * on the assistant message itself as `MessageAbortedError` — the same signal the
 * `session.error` branch of this plugin already keys on, and the signal the spike
 * observed on aborted messages (`spike/log.jsonl` events `message.updated` with
 * `"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}}`).
 * The part's own error text cannot make that distinction (both paths read
 * "Task cancelled"), and the parent session is necessarily busy while the
 * transform runs, so its status carries no abort information.
 */
function isAbortedParent(message: MessageEntry): boolean {
	if (message.info.role !== 'assistant') return false
	return message.info.error?.name === 'MessageAbortedError'
}

/**
 * Child session id. The task tool writes `metadata.sessionId` into the part
 * state while the child runs, and the value survives the cancel
 * (`spike/log.jsonl` error states of all three phantom runs carry
 * `metadata.sessionId` next to `metadata.parentSessionId`).
 * Nothing else identifies the child reliably: `session.children()` exposes only
 * title/time, and no observed evidence shows a collision-free match key, so an
 * unresolvable id is reported instead of guessed.
 */
function childSessionID(state: ErrorState): string | undefined {
	return readString(state.metadata, 'sessionId')
}

/** The child's model, captured by the task tool as `metadata.model`. */
function childModel(state: ErrorState): { providerID: string; modelID: string } | undefined {
	const model: unknown = state.metadata === undefined ? undefined : state.metadata.model
	const providerID = readString(model, 'providerID')
	const modelID = readString(model, 'modelID')
	if (providerID === undefined || modelID === undefined) return undefined
	return { providerID, modelID }
}

function lastAssistant(messages: readonly MessageEntry[]): AssistantEntry | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const entry = messages[index]
		if (entry === undefined || entry.info.role !== 'assistant') continue
		return { info: entry.info, parts: entry.parts }
	}
	return undefined
}

function textOf(parts: readonly Part[]): string {
	let text = ''
	for (const part of parts) {
		if (part.type === 'text') text += part.text
	}
	return text
}

/**
 * Finish reasons that mark a genuinely final model answer.
 *
 * `AssistantMessage.finish` is typed as a bare `finish?: string` in
 * `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` — no enum, no
 * constraints — so the guard must allow-list instead of deny-listing: an absent
 * or unknown value is never an answer. Spike evidence (`spike/log.jsonl`, subagent
 * turns) shows exactly two values: `stop` (18 occurrences, always a completed
 * answer with `time.completed`) and `tool-calls` (6 occurrences, all written with
 * `time.completed` already set while the task tool and later turns were still
 * outstanding) — which is why `time.completed` alone cannot prove terminality.
 * The remaining members are the canonical terminal reasons of the supported
 * providers: `end_turn`, `stop_sequence` and `max_tokens` (Anthropic), and
 * `length` (AI SDK/OpenAI truncation — truncated, but still a final answer).
 * Explicitly never terminal: `tool-calls`, `unknown`, `error`, `content-filter`,
 * `other`.
 */
const TERMINAL_FINISH: ReadonlySet<string> = new Set(['stop', 'end_turn', 'length', 'max_tokens', 'stop_sequence'])

/** A tool part of a child turn that is still pending or running. */
function hasOutstandingToolPart(parts: readonly Part[]): boolean {
	return parts.some(
		(part) => part.type === 'tool' && (part.state.status === 'pending' || part.state.status === 'running')
	)
}

/**
 * The child's final answer, or `undefined` while it is still running. An errored
 * turn is never an answer even when it already wrote partial text: the aborted
 * child message in `spike/log.jsonl` carries `MessageAbortedError` together with
 * `time.completed`. A turn is only terminal when its `finish` reason is in
 * `TERMINAL_FINISH` and no tool part of that turn is still pending/running: a
 * `tool-calls` turn already carries `time.completed` in the spike, so neither
 * field on its own proves the model produced its final answer.
 */
function finalText(entry: AssistantEntry): string | undefined {
	const info = entry.info
	if (info.error !== undefined) return undefined
	if (info.finish === undefined || !TERMINAL_FINISH.has(info.finish)) return undefined
	if (hasOutstandingToolPart(entry.parts)) return undefined
	const text = textOf(entry.parts)
	return text.length > 0 ? text : undefined
}

/**
 * Completed-shaped state for the recovered part. `ToolStateCompleted` requires
 * `title` and `metadata`, neither of which `ToolStateError` carries, so the title
 * is restored from the part when opencode kept one, else from the task
 * description the spike shows the title was derived from.
 */
function completedState(state: ErrorState, text: string): CompletedState {
	return {
		status: 'completed',
		input: state.input,
		output: text,
		title: readString(state, 'title') ?? readString(state.input, 'description') ?? 'task',
		metadata: state.metadata ?? {},
		time: { start: state.time.start, end: state.time.end }
	}
}

/** Error text the parent model can act on: it names the child and says what to do. */
function explainError(outcome: Extract<TaskGuardOutcome, { kind: 'explained' }>): string {
	return `Task cancelled (phantom): ${outcome.reason}. Child session id: ${outcome.childID}. Ask the user to retry the task or inspect that session.`
}

/**
 * Transform guard for one plugin instance. Outcomes are cached per owning part
 * identity so a later transform reuses them instantly, and concurrent transforms
 * for the same part share the single in-flight wait.
 */
export function createTaskGuard(options: TaskGuardOptions): TransformHandler {
	const { client, logger, timeoutMs, resendInterruptedChild } = options
	const now = options.now ?? Date.now
	const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)))
	const outcomes = new Map<string, Promise<TaskGuardOutcome>>()

	/**
	 * Bounds an already-started client call by the absolute `deadline`, racing it against a timer
	 * built on the injected `sleep`. On timeout `controller` aborts the call's `AbortSignal` (the SDK
	 * request options inherit `signal` from `RequestInit`), so the fetch is cancelled rather than
	 * abandoned; the losing promise always carries a no-op catch so it cannot reject unhandled.
	 */
	const withDeadline = async <T>(pending: Promise<T>, controller: AbortController, deadline: number): Promise<T> => {
		let done = false
		const tracked = pending.finally(() => {
			done = true
		})
		// A call settling within these microtask turns never arms the timer, so fast calls leave the
		// injected clock untouched; only a stalled call is raced against the remaining deadline.
		for (let turn = 0; turn < SETTLE_YIELD && !done; turn += 1) await Promise.resolve()
		if (done) return await tracked
		const remainingMs = Math.max(0, deadline - now())
		const timer = sleep(remainingMs).then(() => {
			controller.abort()
			throw new DeadlineExceededError(remainingMs)
		})
		timer.catch(() => {})
		return await Promise.race([tracked, timer])
	}

	const childStatus = async (childID: string, deadline: number): Promise<ChildStatus> => {
		const controller = new AbortController()
		const result = await withDeadline(client.session.status({ signal: controller.signal }), controller, deadline)
		// A failed status read is a failed poll, never an implicit value: it must not be
		// read as `idle`, so the loop logs it at debug and keeps polling until the deadline.
		if (result.error !== undefined) throw new Error(`session.status read failed: ${describeError(result.error)}`)
		const statuses = result.data
		if (statuses === undefined) return 'unknown'
		return statuses[childID]?.type ?? 'unknown'
	}

	/**
	 * The child's messages, or a FAILED POLL. An SDK-shaped error and a missing `data`
	 * both mean the inspection did not happen — never that the child has an empty
	 * history. The throw makes the wait loop log it at debug and keep polling, so a
	 * resume can only ever follow a successful read that showed no final answer.
	 */
	const childMessages = async (childID: string, deadline: number): Promise<MessageEntry[]> => {
		const controller = new AbortController()
		const pending = client.session.messages({ path: { id: childID }, signal: controller.signal })
		const result = await withDeadline(pending, controller, deadline)
		if (result.error !== undefined) throw new Error(`session.messages read failed: ${describeError(result.error)}`)
		if (result.data === undefined) throw new Error('session.messages read returned no data')
		return result.data
	}

	/**
	 * One resume prompt, with the agent the task was started under. Swallows every failure
	 * except a blown deadline, which the wait reports as the timeout.
	 */
	const resumeChild = async (
		childID: string,
		agent: string,
		model: { providerID: string; modelID: string } | undefined,
		text: string,
		deadline: number
	): Promise<void> => {
		try {
			const controller = new AbortController()
			const prompt = client.session.promptAsync({
				path: { id: childID },
				body: {
					// An explicit agent is mandatory: without one opencode rewrites the
					// child session's agent (the spike resend came back as
					// `gentle-orchestrator`, `spike/log.jsonl` message.updated of the
					// resumed user message).
					agent,
					parts: [{ type: 'text', text }],
					...(model === undefined ? {} : { model })
				},
				signal: controller.signal
			})
			const result = await withDeadline(prompt, controller, deadline)
			if (result.error !== undefined) {
				logger.warn(`task guard: resuming child session ${childID} failed: ${describeError(result.error)}`)
			}
		} catch (error) {
			// A blown deadline is the wait's own timeout, not a resume failure.
			if (error instanceof DeadlineExceededError) throw error
			logger.warn(`task guard: resuming child session ${childID} failed: ${describeError(error)}`)
		}
	}

	/** Bounded wait for the orphaned child. Never rejects. */
	const waitForChild = async (part: PhantomPart, childID: string): Promise<TaskGuardOutcome> => {
		const agent = readString(part.state.input, 'subagent_type')
		const model = childModel(part.state)
		const resumeText = readString(part.state.input, 'prompt') ?? DEFAULT_RESUME_TEXT
		const started = now()
		const deadline = started + timeoutMs
		let resumed = false

		for (;;) {
			try {
				const status = await childStatus(childID, deadline)
				const running = status === 'busy' || status === 'retry'
				const messages = await childMessages(childID, deadline)
				const last = lastAssistant(messages)
				if (last !== undefined) {
					// A child error is terminal only once it stopped running: while it is
					// still busy the host may simply be retrying that very turn.
					if (last.info.error !== undefined && !running) {
						return {
							kind: 'explained',
							childID,
							reason: `the subagent session ended with ${last.info.error.name}`
						}
					}
					const text = finalText(last)
					// Recovery also requires the child not to be running: while it reports
					// `busy`/`retry` the host may simply be retrying that very turn, so even
					// a terminal finish stays provisional until the child settles.
					if (text !== undefined && !running) return { kind: 'recovered', text }
				}
				// Idle without a final answer: the orphan never finished its turn. The
				// status map may simply omit idle sessions, so a resume is only ever
				// sent on an explicit `idle`, never on an unknown status, and only after
				// a successful message read — a failed one throws above, before here.
				if (!resumed && status === 'idle' && resendInterruptedChild && now() - started >= RESEND_GRACE_MS) {
					resumed = true
					if (agent === undefined) {
						logger.warn(
							`task guard: child session ${childID} is idle without an answer and carries no subagent_type; not resuming it`
						)
					} else {
						logger.info(`task guard: resuming interrupted child session ${childID} as agent "${agent}"`)
						await resumeChild(childID, agent, model, resumeText, deadline)
					}
				}
			} catch (error) {
				if (error instanceof DeadlineExceededError) {
					return {
						kind: 'explained',
						childID,
						reason: `the subagent session did not respond within the ${Math.round(timeoutMs / 1000)}s timeout`
					}
				}
				logger.debug(`task guard: polling child session ${childID} failed: ${describeError(error)}`)
			}
			const remaining = deadline - now()
			if (remaining <= 0) {
				return {
					kind: 'explained',
					childID,
					reason: `the subagent session produced no final answer within ${Math.round(timeoutMs / 1000)}s`
				}
			}
			await sleep(Math.min(POLL_MS, remaining))
		}
	}

	const resolveOutcome = async (part: PhantomPart): Promise<TaskGuardOutcome> => {
		const childID = childSessionID(part.state)
		if (childID === undefined) {
			logger.warn('task guard: phantom task cancel carries no child session id; leaving the part untouched')
			return { kind: 'unchanged' }
		}
		try {
			const outcome = await waitForChild(part, childID)
			// Logged once per tool call, at resolution time: a cached outcome replayed
			// by a later transform must not spam the log again.
			if (outcome.kind === 'recovered') {
				logger.info(`task guard: recovered the answer of child session ${childID} for this task call`)
			} else if (outcome.kind === 'explained') {
				logger.warn(`task guard: ${childID}: ${outcome.reason}`)
			}
			return outcome
		} catch (error) {
			// Nothing may escape the hook, and the parent still needs a way forward.
			const reason = `the subagent session could not be inspected (${describeError(error)})`
			logger.warn(`task guard: ${childID}: ${reason}`)
			return { kind: 'explained', childID, reason }
		}
	}

	/**
	 * Rewrites the part in place. The mutation goes through the tool part's own
	 * state union (which admits both `completed` and `error`) while the incoming
	 * state stays narrowed to the phantom `error` by `isPhantomTaskPart`.
	 */
	const applyOutcome = (part: PhantomPart, outcome: TaskGuardOutcome): void => {
		const target = part as ToolPart
		if (outcome.kind === 'recovered') {
			target.state = completedState(part.state, outcome.text)
		} else if (outcome.kind === 'explained') {
			target.state = { ...part.state, error: explainError(outcome) }
		}
	}

	/**
	 * Cache key of the owning part identity (review R3-unscoped-outcome-cache): an
	 * equal `callID` is not unique across sessions or messages, so the key also
	 * carries the part's own `sessionID` and `messageID`, falling back to the part
	 * id when the call id is empty. Fresh message trees and concurrent transforms
	 * of the same part keep those three fields, so they still reuse one cached
	 * outcome and share one in-flight wait.
	 */
	const outcomeKey = (part: PhantomPart): string =>
		[part.sessionID, part.messageID, part.callID.length > 0 ? part.callID : part.id].join('\u0000')

	const evictOldest = (): void => {
		if (outcomes.size <= MAX_CACHED_OUTCOMES) return
		const oldest = outcomes.keys().next()
		if (!oldest.done) outcomes.delete(oldest.value)
	}

	return async (_input, output) => {
		try {
			for (const message of output.messages) {
				if (isAbortedParent(message)) continue
				for (const part of message.parts) {
					if (!isPhantomTaskPart(part)) continue
					const key = outcomeKey(part)
					let pending = outcomes.get(key)
					if (pending === undefined) {
						pending = resolveOutcome(part)
						outcomes.set(key, pending)
						evictOldest()
					}
					// A cached outcome is replayed onto the part of this call, because the
					// host may hand out a fresh message tree every time.
					applyOutcome(part, await pending)
				}
			}
		} catch (error) {
			logger.error(`task guard transform failed: ${describeError(error)}`)
		}
	}
}

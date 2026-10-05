/**
 * Runtime wiring: config loading, best-effort agent validation, and the opencode
 * hooks that drive the fallback chain.
 *
 * Startup contract: `createHooks` and the `config` hook NEVER await a client
 * call. The opencode server does not answer HTTP until plugin initialization
 * finishes, so any awaited client call during init deadlocks boot. Agent-name
 * validation therefore runs detached: synchronously from the config-hook agent
 * map when that map is available, and otherwise as a deferred, bounded,
 * fire-and-forget server fetch that swallows every failure at debug level.
 *
 * State machine per session (one user request at a time):
 * - `chat.message` (genuine) starts a request: captures the resendable user
 *   parts, the request's user message ids, and the identity of the resolved
 *   model, so a `session.error` can be attributed to this request before
 *   `chat.params` runs; only the message carrying the id passed to
 *   `promptAsync` counts as this plugin's resend echo, and it contributes its
 *   user message ids plus the resend target's identity while that resend is
 *   still pending.
 * - `chat.params` records the model actually being used and clears the resend
 *   marker set by this plugin's own echo, but only when the params answer a
 *   message of the live request: a late params call for a superseded resend or
 *   for an older request is ignored.
 * - `message.updated` failures (correlated to the live request through the
 *   assistant message's parent user message) and delayed `session.error` events
 *   walk the chain once per request via `selectNextEntry`, resending the
 *   original user parts with the next configured model. A `session.error` whose
 *   text names the live model as opencode's own registry rejection
 *   (`Model not found: <provider>/<model>.`) bypasses the pending-resend guard
 *   and twin suppression: opencode publishes it before `chat.params`, so the
 *   rejection of a resend target would otherwise stall the chain.
 *
 * Hooks never throw: every entry point is wrapped so a plugin defect cannot
 * break the host.
 */

import type { Hooks, Plugin } from '@opencode-ai/plugin'
import { chainFor, parseModelRef, resolvePool, type ChainEntry } from '../domain/config'
import { createPoolCooldowns } from '../domain/cooldown'
import { classifyError } from '../domain/error-classifier'
import { selectNextEntry, type FailingIdentity } from '../domain/selection'
import { fetchKnownAgents, knownAgentsFromConfig, unknownAgentNames } from './agents'
import { defaultConfigLoaderDeps, loadConfig, type ConfigLoaderDeps } from './config-loader'
import { createLogger, type Logger } from './log'
import { createTaskGuard } from './task-guard'

type Client = Parameters<Plugin>[0]['client']
type ChatMessageInput = Parameters<NonNullable<Hooks['chat.message']>>[0]
type ChatMessageOutput = Parameters<NonNullable<Hooks['chat.message']>>[1]
type ChatParamsInput = Parameters<NonNullable<Hooks['chat.params']>>[0]
type ConfigHookInput = Parameters<NonNullable<Hooks['config']>>[0]
type EventInput = Parameters<NonNullable<Hooks['event']>>[0]
type Part = ChatMessageOutput['parts'][number]
type PromptBody = NonNullable<Parameters<Client['session']['promptAsync']>[0]['body']>
type ResendPart = PromptBody['parts'][number]
type TimerHandle = ReturnType<typeof setTimeout>

/**
 * Grace period before acting on a session-level error. The twin
 * `message.updated` failure usually arrives first; letting it win avoids
 * double-sending.
 */
const DEFAULT_SESSION_ERROR_GRACE_MS = 250

/**
 * Bound on the detached server-side agent-validation fetch. The call is never
 * awaited, so this only keeps a hung transport from leaving the once-only
 * background attempt unresolved forever.
 */
const AGENT_VALIDATION_TIMEOUT_MS = 2000

/**
 * A `session.error` arriving within this window of an already-observed failure is the
 * same failure only while the session still runs the identity that failed: opencode
 * emits both roughly 20ms apart, while a resend can move the session to another model
 * inside the very same window.
 */
const TWIN_FAILURE_SLACK_MS = 100

export type RuntimeDeps = {
	client: Client
	projectDirectory: string
	/** Injectable config-loader dependencies; defaults to the real filesystem. */
	configLoader?: Omit<ConfigLoaderDeps, 'projectDirectory'>
	/** Override the session.error grace period (tests). */
	sessionErrorGraceMs?: number
	/** Override the pool-cooldown clock (tests). */
	now?: () => number
}

type Failure = {
	/** Assistant message ID, when the failure came from `message.updated`. */
	messageID?: string
	agent?: string
	providerID?: string
	modelID?: string
	/** Absent means the model's default variant. */
	variant?: string
	error: unknown
}

/** Session identity: agent plus the model (and variant) the session is running. */
type Identity = { agent?: string; providerID?: string; modelID?: string; variant?: string }

type SessionState = {
	identity: Identity
	/** Resendable parts of the current user request. */
	parts: ResendPart[]
	/** Identities that produced a fallback-eligible failure this request. */
	failed: ChainEntry[]
	/** Everything consumed this request: failed identities plus chosen entries. */
	attempted: ChainEntry[]
	/** Assistant message IDs already handled this request. */
	handled: Set<string>
	/** User message IDs of this request: the genuine one plus this plugin's resend echoes. */
	requestUserIDs: Set<string>
	exhaustedLogged: boolean
	/** True while waiting for the echo of this plugin's own resend. */
	pendingResend: boolean
	/** User message ids assigned to this plugin's own resends: only those are echoes. */
	resendIDs: Set<string>
	/** Incremented on every genuine `chat.message`: identifies the live request. */
	requestSeq: number
	/** Incremented on every resend: only the latest attempt may write state after its prompt resolves. */
	resendSeq: number
	lastFailureAt?: number
	/** Identity that produced `lastFailureAt`: twin suppression compares it with the live one. */
	lastFailureIdentity?: Identity
	/** Non-error assistant update for the live identity after `lastFailureAt`: proof that model really ran. */
	liveRun?: { at: number; identity: Identity }
	errorTimer?: TimerHandle
}

function readString(value: unknown, key: string): string | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const found: unknown = (value as Record<string, unknown>)[key]
	return typeof found === 'string' ? found : undefined
}

function errorDetails(error: unknown): { name?: string; message?: string; statusCode?: number } {
	if (typeof error !== 'object' || error === null) return {}
	const record = error as Record<string, unknown>
	const name = typeof record.name === 'string' ? record.name : undefined
	const data: unknown = record.data
	if (typeof data !== 'object' || data === null) return { name }
	const details = data as Record<string, unknown>
	return {
		name,
		message: typeof details.message === 'string' ? details.message : undefined,
		statusCode: typeof details.statusCode === 'number' ? details.statusCode : undefined
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Bound a promise by a timeout: on expiry the returned promise rejects while
 * the input promise is abandoned in place — its handlers stay attached, so a
 * late settlement can neither reject unhandled nor change the outcome.
 */
function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
		void promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error: unknown) => {
				clearTimeout(timer)
				reject(error)
			}
		)
	})
}

/** Chat params `model.id` may be a bare modelID or `provider/modelID`. */
function modelIDFor(providerID: string, id: string): string {
	const prefix = `${providerID}/`
	return id.startsWith(prefix) ? id.slice(prefix.length) : id
}

/**
 * The live identity a `chat.message` establishes for its user message: the agent plus the
 * resolved model opencode's run loop looks up next (`getModel` runs on exactly this pair,
 * before `chat.params`). Seeding here is what lets a `session.error` be attributed to this
 * request without waiting for `chat.params` — including opencode's own registry rejection
 * `Model not found: ...`, which the run loop publishes for a model that never reaches
 * `chat.params` at all.
 */
function identityFromChatMessage(input: ChatMessageInput, output: ChatMessageOutput): Identity {
	const model = input.model ?? output.message.model
	return {
		agent: input.agent ?? output.message.agent,
		providerID: model.providerID,
		modelID: modelIDFor(model.providerID, model.modelID),
		// `input.variant` is the declared source; the installed SDK type omits the `variant`
		// the user message carries at runtime, so it is read defensively from the message.
		variant: input.variant ?? readString(output.message.model, 'variant')
	}
}

/**
 * Whether a `session.error` message is opencode's own registry rejection of exactly the
 * model the session is running: its run loop publishes `Model not found: <provider>/<model>.`
 * (plus an optional suggestion) after `chat.message` and before `chat.params`, so the
 * embedded ids are the only signal tying the failure to that model. The closing dot must end
 * the message or precede the suggestion's space, so `c2` never matches a rejection of `c2.x`.
 */
function rejectsLiveModel(message: string | undefined, providerID: string, modelID: string): boolean {
	const prefix = `Model not found: ${providerID}/${modelID}.`
	if (message === undefined || !message.startsWith(prefix)) return false
	return message.length === prefix.length || message[prefix.length] === ' '
}

function identityEntry(identity: { providerID: string; modelID: string; variant?: string }): ChainEntry {
	const entry: ChainEntry = { model: `${identity.providerID}/${identity.modelID}` }
	if (identity.variant !== undefined) entry.variant = identity.variant
	return entry
}

function sameEntry(a: ChainEntry, b: ChainEntry): boolean {
	return a.model === b.model && a.variant === b.variant
}

/** Compare full session identities, including the model's variant. */
function sameIdentity(a: Identity, b: Identity): boolean {
	return a.agent === b.agent && a.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant
}

/**
 * Map a stored user-message part to the resend input shape. Session/message
 * correlation fields are stripped: the resend re-associates parts itself.
 */
function toResendPart(part: Part): ResendPart | null {
	switch (part.type) {
		case 'text':
			return { type: 'text', text: part.text }
		case 'file':
			return {
				type: 'file',
				mime: part.mime,
				url: part.url,
				...(part.filename === undefined ? {} : { filename: part.filename }),
				...(part.source === undefined ? {} : { source: part.source })
			}
		case 'agent':
			return {
				type: 'agent',
				name: part.name,
				...(part.source === undefined ? {} : { source: part.source })
			}
		case 'subtask':
			return { type: 'subtask', prompt: part.prompt, description: part.description, agent: part.agent }
		default:
			return null
	}
}

function mapResendParts(parts: readonly Part[]): ResendPart[] {
	const mapped: ResendPart[] = []
	for (const part of parts) {
		const resend = toResendPart(part)
		if (resend !== null) mapped.push(resend)
	}
	return mapped
}

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * Unique id for one resend, shaped like opencode's own: `msg_` + 12 time-ordered
 * hex chars + 14 random chars. The installed server (1.18.34) checks a `msg`
 * prefix and creates the user message as `id: body.messageID ?? <generated>`, so
 * this is the id the echo carries and `chat.message` correlates on.
 */
function nextResendMessageID(): string {
	const time = ((BigInt(Date.now()) * 0x1000n) | 1n) & 0xffffffffffffn
	const random = crypto.getRandomValues(new Uint8Array(14))
	let suffix = ''
	for (const byte of random) suffix += ID_ALPHABET.charAt(byte % ID_ALPHABET.length)
	return `msg_${time.toString(16).padStart(12, '0')}${suffix}`
}

export async function createHooks(deps: RuntimeDeps): Promise<Hooks> {
	const { client } = deps
	const logger: Logger = createLogger(client)

	const loaderDeps: ConfigLoaderDeps =
		deps.configLoader === undefined
			? defaultConfigLoaderDeps(deps.projectDirectory)
			: { projectDirectory: deps.projectDirectory, ...deps.configLoader }
	const loaded = loadConfig(loaderDeps)
	const config = loaded.config
	for (const issue of loaded.issues) {
		const text = `${issue.path}: ${issue.message}`
		if (issue.severity === 'error') logger.error(text)
		else logger.warn(text)
	}

	/** Validation runs once: the first available known-agent source wins. */
	let agentsValidated = false
	const validateAgents = (known: ReadonlySet<string>): void => {
		agentsValidated = true
		for (const name of unknownAgentNames(config.agents, known)) {
			logger.warn(`unknown agent "${name}" in the agent-fallback configuration`)
		}
	}

	/**
	 * Server-side validation, detached so plugin initialization can never wait
	 * on the HTTP client: the opencode server does not answer requests until
	 * init finishes, so awaiting `client.app.agents()` here deadlocks boot. The
	 * attempt runs at most once, starts on the next loop turn (after
	 * initialization), is bounded by `AGENT_VALIDATION_TIMEOUT_MS`, never
	 * throws — every failure is logged at debug level — and stands down when a
	 * config-hook validation already ran, before or during the fetch.
	 */
	let serverValidationStarted = false
	const scheduleServerValidation = (): void => {
		if (serverValidationStarted) return
		serverValidationStarted = true
		setTimeout(() => {
			if (agentsValidated) return
			void (async () => {
				try {
					const known = await withTimeout(fetchKnownAgents(client), AGENT_VALIDATION_TIMEOUT_MS)
					if (agentsValidated) return
					if (known !== null) validateAgents(known)
					else logger.debug('agent validation skipped: no known-agent source available')
				} catch (error) {
					logger.debug(`background agent validation failed: ${describeError(error)}`)
				}
			})()
		}, 0)
	}
	scheduleServerValidation()

	const sessions = new Map<string, SessionState>()
	let disposed = false
	const graceMs = deps.sessionErrorGraceMs ?? DEFAULT_SESSION_ERROR_GRACE_MS
	// One cooldown tracker for the whole plugin: a pool cooled by one session is skipped
	// by every later selection, in any session, until the clock passes its deadline.
	const cooldowns = createPoolCooldowns(config.cooldownSeconds, deps.now ?? Date.now)

	/** Whether a chain entry may run now: neither its pool nor its model may be cooling down. */
	const entryAvailable = (entry: ChainEntry): boolean => {
		const ref = parseModelRef(entry.model)
		if (ref === null) return true
		return !cooldowns.isCooling({ pool: resolvePool(ref.providerID, config.pools), model: entry.model })
	}

	const getState = (sessionID: string): SessionState => {
		let state = sessions.get(sessionID)
		if (state === undefined) {
			state = {
				identity: {},
				parts: [],
				failed: [],
				attempted: [],
				handled: new Set<string>(),
				requestUserIDs: new Set<string>(),
				exhaustedLogged: false,
				pendingResend: false,
				resendIDs: new Set<string>(),
				requestSeq: 0,
				resendSeq: 0
			}
			sessions.set(sessionID, state)
		}
		return state
	}

	const cancelErrorTimer = (state: SessionState): void => {
		if (state.errorTimer !== undefined) {
			clearTimeout(state.errorTimer)
			state.errorTimer = undefined
		}
	}

	/**
	 * One exhaustion log per request. Without the availability filter a reachable
	 * entry still exists, so only the cooldown hides it: say that instead of
	 * claiming the chain is done.
	 */
	const logExhausted = (
		sessionID: string,
		agent: string,
		state: SessionState,
		chain: readonly ChainEntry[],
		failing: FailingIdentity
	): void => {
		if (state.exhaustedLogged) return
		state.exhaustedLogged = true
		if (selectNextEntry(chain, failing, state.attempted) !== null) {
			logger.warn(`fallback chain for agent "${agent}" in session ${sessionID}: every remaining entry is cooling down`)
		} else {
			logger.warn(`fallback chain exhausted for agent "${agent}" in session ${sessionID}`)
		}
	}

	/** Walk one step further along the chain: send the original parts with `next`'s model. */
	const resendNext = async (sessionID: string, state: SessionState, agent: string, next: ChainEntry): Promise<void> => {
		const target = parseModelRef(next.model)
		if (target === null) return

		// The id this resend's user message will carry: how `chat.message` recognizes
		// the echo instead of guessing from a boolean.
		const resendID = nextResendMessageID()
		state.pendingResend = true
		state.resendIDs.add(resendID)
		state.attempted.push(next)
		state.resendSeq += 1
		const resendSeq = state.resendSeq
		const body = {
			agent,
			model: { providerID: target.providerID, modelID: target.modelID },
			parts: state.parts,
			messageID: resendID,
			...(next.variant === undefined ? {} : { variant: next.variant })
		}
		const requestSeq = state.requestSeq
		try {
			await client.session.promptAsync({ path: { id: sessionID }, body })
			// The resent entry is what runs now: record its model AND variant (absent variant =
			// the model's default) as the live identity, so a later session-only failure is
			// attributed to the right chain position instead of restarting the chain.
			// A newer request or a newer resend owns the state now: a late completion must not
			// clobber it, or an already-failed model would be restored as the live one.
			if (state.requestSeq !== requestSeq || state.resendSeq !== resendSeq) return
			state.identity = {
				agent,
				providerID: target.providerID,
				modelID: target.modelID,
				variant: next.variant
			}
			const suffix = next.variant === undefined ? '' : ` (${next.variant})`
			logger.info(`falling back for session ${sessionID}: ${next.model}${suffix}`)
		} catch (error) {
			// Same generation guards: a newer request's or resend's markers are not ours to clear.
			if (state.requestSeq !== requestSeq || state.resendSeq !== resendSeq) return
			state.pendingResend = false
			state.resendIDs.delete(resendID)
			logger.error(`resend failed for session ${sessionID}: ${describeError(error)}`)
		}
	}

	/** Stop the host's own retry loop for `sessionID`; never throws. Returns whether it worked. */
	const abortSession = async (sessionID: string): Promise<boolean> => {
		try {
			await client.session.abort({ path: { id: sessionID } })
			return true
		} catch (error) {
			logger.error(`abort failed for session ${sessionID}: ${describeError(error)}`)
			return false
		}
	}

	/** Shared failure handling for `message.updated` and delayed `session.error`. */
	const processFailure = async (sessionID: string, failure: Failure): Promise<void> => {
		if (!config.enabled) return
		const state = getState(sessionID)
		if (failure.messageID !== undefined) {
			if (state.handled.has(failure.messageID)) return
			state.handled.add(failure.messageID)
		}
		state.lastFailureAt = Date.now()
		state.lastFailureIdentity = {
			agent: failure.agent,
			providerID: failure.providerID,
			modelID: failure.modelID,
			variant: failure.variant
		}

		const details = errorDetails(failure.error)
		const kind = classifyError({ message: details.message, statusCode: details.statusCode }).kind
		if (kind === 'not-fallback') return

		const { agent, providerID, modelID, variant } = failure
		if (agent === undefined || providerID === undefined || modelID === undefined) return

		const failing: FailingIdentity = { providerID, modelID, ...(variant === undefined ? {} : { variant }) }
		const failingEntry = identityEntry(failing)
		if (state.failed.some((entry) => sameEntry(entry, failingEntry))) return
		state.failed.push(failingEntry)
		state.attempted.push(failingEntry)
		// The failure cools its scope (pool or model, per kind) BEFORE selection: this
		// selection already skips that scope, and so does every later one until the
		// configured duration passes.
		cooldowns.mark(kind, { pool: resolvePool(providerID, config.pools), model: failingEntry.model })

		if (state.parts.length === 0) {
			logger.warn(`no user message parts captured for session ${sessionID}; skipping fallback`)
			return
		}

		const chain = chainFor(agent, config)
		if (chain.length === 0) return

		const next = selectNextEntry(chain, failing, state.attempted, entryAvailable)
		if (next === null) {
			logExhausted(sessionID, agent, state, chain, failing)
			return
		}

		await resendNext(sessionID, state, agent, next)
	}

	/**
	 * The phantom `Task cancelled` guard. It is the only channel that can still
	 * show the model the orphaned child's answer, so it is wired exactly when both
	 * the plugin and the task guard are enabled; otherwise the transform hook is
	 * not registered at all and costs nothing per LLM call.
	 */
	const taskGuard =
		config.enabled && config.taskGuard.enabled
			? createTaskGuard({
					client,
					logger,
					timeoutMs: config.taskGuard.timeoutSeconds * 1000,
					resendInterruptedChild: config.taskGuard.resendInterruptedChild
				})
			: undefined

	const hooks: Hooks = {
		dispose: async () => {
			try {
				disposed = true
				for (const state of sessions.values()) cancelErrorTimer(state)
				sessions.clear()
			} catch (error) {
				logger.error(`dispose hook failed: ${describeError(error)}`)
			}
		},

		event: async (input: EventInput) => {
			try {
				const event = input.event
				if (event.type === 'message.updated') {
					const info = event.properties.info
					if (info.role !== 'assistant') return
					const state = getState(info.sessionID)
					const parentID = readString(info, 'parentID')
					const messageError: unknown = info.error
					if (messageError === undefined || messageError === null) {
						// An error-free assistant update for the model the session is running, rooted
						// in this request, proves that model actually ran here: a later `session.error`
						// may then be attributed to it (see the twin check below).
						const live = state.identity
						if (
							live.providerID !== undefined &&
							live.modelID !== undefined &&
							live.providerID === info.providerID &&
							live.modelID === info.modelID &&
							(parentID === undefined || state.requestUserIDs.has(parentID))
						) {
							state.liveRun = { at: Date.now(), identity: { ...live } }
						}
						return
					}
					// Correlate the failure to the live request: an assistant failure whose parent
					// user message belongs to another request must not resend this request's parts.
					// When the event carries no parent id the correlation is impossible, so that
					// event keeps the previous session-only behavior.
					if (parentID !== undefined && !state.requestUserIDs.has(parentID)) return
					// The message failure wins: drop the twin session.error grace timer.
					cancelErrorTimer(state)
					// The installed assistant event carries no variant metadata, so a bare failure
					// would look like the model's default variant and the exact-identity selector
					// could not find the chain entry it came from. Borrow the live variant only
					// when the event reports the model the session is actually running.
					const eventVariant = readString(info, 'variant')
					const live = state.identity
					const sameModel = live.providerID === info.providerID && live.modelID === info.modelID
					await processFailure(info.sessionID, {
						messageID: info.id,
						agent: readString(info, 'agent') ?? live.agent,
						providerID: info.providerID,
						modelID: info.modelID,
						variant: eventVariant ?? (sameModel ? live.variant : undefined),
						error: messageError
					})
				} else if (event.type === 'session.error') {
					const { sessionID, error } = event.properties
					if (sessionID === undefined || error === undefined) return
					const details = errorDetails(error)
					if (details.name === 'MessageAbortedError') return
					if (classifyError({ message: details.message, statusCode: details.statusCode }).kind === 'not-fallback') {
						return
					}
					const state = getState(sessionID)
					const { agent, providerID, modelID, variant } = state.identity
					if (agent === undefined || providerID === undefined || modelID === undefined) return
					// opencode rejects an unknown model id in its own run loop, after `chat.message`
					// and before `chat.params`, so when this plugin's resend target is rejected that
					// way `pendingResend` still guards the resend and the previous failure's twin
					// window still holds. The rejected ids embedded in the message name the model the
					// session is running, which proves this failure belongs to the resend target and
					// not to the run it replaced: only that exact match may bypass both guards. Every
					// other error keeps them, so a late error or host retry of the replaced run stays
					// ignored while the resend settles.
					const rejectedLive = rejectsLiveModel(details.message, providerID, modelID)
					if (state.pendingResend && !rejectedLive) return
					const now = Date.now()
					// Twin suppression is evidence-gated, not time-only. Inside the window a
					// `session.error` is the same failure when it names the identity that just
					// failed (the second channel of one failure), or when nothing proves the
					// identity now live has produced output for this request since that failure:
					// a resend moved the session on, but the new model has not run yet, so the
					// error still carries the old failure. The error-free assistant update
					// recorded as `liveRun` is that proof, which lets a genuinely new fast
					// failure of the next model advance while the late twin stays ignored.
					const liveRan =
						state.liveRun !== undefined &&
						state.lastFailureAt !== undefined &&
						state.liveRun.at >= state.lastFailureAt &&
						sameIdentity(state.liveRun.identity, state.identity)
					const twin =
						state.lastFailureAt !== undefined &&
						now - state.lastFailureAt <= TWIN_FAILURE_SLACK_MS &&
						state.lastFailureIdentity !== undefined &&
						(sameIdentity(state.lastFailureIdentity, state.identity) || !liveRan)
					if (twin && !rejectedLive) return
					state.lastFailureAt = now
					state.lastFailureIdentity = { agent, providerID, modelID, variant }
					cancelErrorTimer(state)
					// Bind the delayed failure to the identity and request live now: by the time the
					// timer fires the session may already be on a different model or a newer request.
					const snapshot: Failure = { agent, providerID, modelID, variant, error }
					const requestSeq = state.requestSeq
					state.errorTimer = setTimeout(() => {
						state.errorTimer = undefined
						if (disposed) return
						// The rejected resend is still the live identity here, so its own rejection may
						// fire even though `pendingResend` is still set; every other delayed failure
						// keeps the guard.
						if (state.pendingResend && !rejectedLive) return
						if (state.requestSeq !== requestSeq) return
						if (!sameIdentity(state.identity, snapshot)) return
						void processFailure(sessionID, snapshot)
					}, graceMs)
				} else if (event.type === 'session.status') {
					const { sessionID, status } = event.properties
					if (status.type !== 'retry') return
					if (!config.enabled) return
					const state = getState(sessionID)
					// While this plugin's own resend is still settling, host retries still describe
					// the run we just aborted: acting on them would abort the fresh generation.
					if (state.pendingResend) return
					const kind = classifyError({ message: status.message }).kind
					if (kind === 'not-fallback') return
					const { agent, providerID, modelID, variant } = state.identity
					if (agent === undefined || providerID === undefined || modelID === undefined) return
					if (state.parts.length === 0) {
						logger.warn(`no user message parts captured for session ${sessionID}; skipping fallback`)
						return
					}
					const failing: FailingIdentity = { providerID, modelID, ...(variant === undefined ? {} : { variant }) }
					const failingEntry = identityEntry(failing)
					if (state.failed.some((entry) => sameEntry(entry, failingEntry))) return
					state.failed.push(failingEntry)
					state.attempted.push(failingEntry)
					// The retry is the same failure a late session.error would carry: keep the
					// twin suppression aligned with it.
					state.lastFailureAt = Date.now()
					state.lastFailureIdentity = { agent, providerID, modelID, variant }
					cooldowns.mark(kind, { pool: resolvePool(providerID, config.pools), model: failingEntry.model })
					// The two records above stay provisional until an abort has succeeded. A rejected
					// abort leaves the host retrying this very identity, so committing it now would make
					// every later retry and every later failure for it return at the guard above for the
					// rest of this request. The cooldown and the last-failure markers stay either way:
					// the failure really was observed, and only twin suppression reads them.
					const rollbackFailure = (): void => {
						const drop = (entries: ChainEntry[]): void => {
							const at = entries.lastIndexOf(failingEntry)
							if (at !== -1) entries.splice(at, 1)
						}
						drop(state.failed)
						drop(state.attempted)
					}

					const chain = chainFor(agent, config)
					if (chain.length === 0) return
					const next = selectNextEntry(chain, failing, state.attempted, entryAvailable)
					if (next === null) {
						logExhausted(sessionID, agent, state, chain, failing)
						// The host is retrying a pool that is down: stop its loop even though
						// there is nothing left to fall back to.
						if (kind === 'pool-unavailable' && !(await abortSession(sessionID))) rollbackFailure()
						return
					}
					// Stop the host's retry loop before our own prompt: two concurrent
					// generations of one request would race for the session.
					// The request identity is captured BEFORE the abort: while that call
					// is in flight a genuine `chat.message` may supersede this request and
					// replace `state.parts`, so resending afterwards would push the NEW
					// request's parts with a chain entry selected for the OLD one.
					const requestSeq = state.requestSeq
					if (!(await abortSession(sessionID))) {
						rollbackFailure()
						return
					}
					if (state.requestSeq !== requestSeq) {
						rollbackFailure()
						return
					}
					await resendNext(sessionID, state, agent, next)
				} else if (event.type === 'session.deleted') {
					const state = sessions.get(event.properties.info.id)
					if (state !== undefined) {
						cancelErrorTimer(state)
						sessions.delete(event.properties.info.id)
					}
				}
			} catch (error) {
				logger.error(`event hook failed: ${describeError(error)}`)
			}
		},

		'chat.message': async (input, output) => {
			try {
				const state = getState(input.sessionID)
				const userIDs = new Set<string>()
				if (input.messageID !== undefined) userIDs.add(input.messageID)
				userIDs.add(output.message.id)
				// Only a message carrying an id this plugin gave one of its own resends is an
				// echo: it joins this request's user message ids but never restarts the chain;
				// every other user message is a genuine new request, resend outstanding or not.
				const isEcho = Array.from(userIDs).some((id) => state.resendIDs.has(id))
				if (isEcho) {
					if (state.pendingResend) {
						for (const id of userIDs) state.requestUserIDs.add(id)
						// The echo is the user message this plugin's own resend created, so its model IS
						// the resend target: record it as the live identity right away. `chat.params`
						// never fires when opencode's registry rejects that target, and `promptAsync`
						// may not have resolved yet, so without this seed the rejection would be
						// attributed to the previous model and the chain would stall. Only the echo of
						// the still-pending resend may write: a stale echo of a superseded one must not
						// touch the identity a newer request owns.
						state.identity = identityFromChatMessage(input, output)
					}
					return
				}
				cancelErrorTimer(state)
				state.identity = identityFromChatMessage(input, output)
				state.parts = mapResendParts(output.parts)
				state.failed = []
				state.attempted = []
				state.handled.clear()
				state.exhaustedLogged = false
				state.lastFailureAt = undefined
				state.lastFailureIdentity = undefined
				state.liveRun = undefined
				state.requestSeq += 1
				state.requestUserIDs = userIDs
				// A superseded resend must not gate this request's session.error; its id
				// stays in resendIDs so a late echo of it is still recognized.
				state.pendingResend = false
			} catch (error) {
				logger.error(`chat.message hook failed: ${describeError(error)}`)
			}
		},

		'chat.params': async (input: ChatParamsInput) => {
			try {
				const state = getState(input.sessionID)
				// Correlate the params with the request they answer: `chat.params` carries the
				// live user message, so it applies only when that message belongs to the current
				// request (its genuine id or one of this request's own resend echoes). A late
				// params call for a superseded resend or for an older request must neither
				// overwrite the identity of a newer genuine request nor release the marker that
				// keeps `session.error` quiet while our resend settles. Without a usable id the
				// correlation is impossible, so the previous unconditional behavior stands.
				const answered = readString(input.message, 'id')
				if (answered !== undefined && answered.length > 0 && !state.requestUserIDs.has(answered)) return
				state.identity.agent = input.agent
				state.identity.providerID = input.model.providerID
				state.identity.modelID = modelIDFor(input.model.providerID, input.model.id)
				// The variant is deliberately left alone: the installed `chat.params` input
				// (its `Model` type) exposes no variant field, so anything written here would
				// be stale. The variant comes from `chat.message` or from this plugin's resend.
				state.pendingResend = false
			} catch (error) {
				logger.error(`chat.params hook failed: ${describeError(error)}`)
			}
		},

		config: async (input: ConfigHookInput) => {
			try {
				if (agentsValidated) return
				// Synchronous and client-free: this hook can run during initialization, so an
				// awaited client call here would deadlock boot exactly like `createHooks` did.
				// The config-hook agent map is the known-agent source; the deferred server
				// fetch stands down once this validation ran.
				const known = knownAgentsFromConfig(input)
				if (known !== null) validateAgents(known)
			} catch (error) {
				logger.error(`config hook failed: ${describeError(error)}`)
			}
		}
	}

	if (taskGuard !== undefined) hooks['experimental.chat.messages.transform'] = taskGuard

	return hooks
}

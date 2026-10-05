/**
 * Logging through the opencode server log endpoint. Every write is swallowed:
 * observability must never become a failure mode for a hook, even when the
 * log transport itself is down.
 */

import type { Plugin } from '@opencode-ai/plugin'

type Client = Parameters<Plugin>[0]['client']

/** Service name attached to every log entry this plugin writes. */
export const LOG_SERVICE = 'opencode-auto-model-fallback'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Logger = {
	debug: (message: string) => void
	info: (message: string) => void
	warn: (message: string) => void
	error: (message: string) => void
}

export function createLogger(client: Client): Logger {
	const write =
		(level: LogLevel) =>
		(message: string): void => {
			try {
				void Promise.resolve(client.app.log({ body: { service: LOG_SERVICE, level, message } })).catch(() => undefined)
			} catch {
				// Synchronous transport failures are swallowed like rejections.
			}
		}
	return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

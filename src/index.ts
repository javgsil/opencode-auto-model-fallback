import type { Plugin } from '@opencode-ai/plugin'
import { createHooks } from './runtime/hooks'

/**
 * OpenCode plugin entry point: loads the fallback config, validates configured
 * agents once, and returns the hooks that drive the fallback chain.
 */
export const opencodeAgentFallback: Plugin = async (input) =>
	createHooks({ client: input.client, projectDirectory: input.directory })

export default opencodeAgentFallback

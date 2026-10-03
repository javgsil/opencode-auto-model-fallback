/**
 * Config file discovery and loading. Filesystem and environment access are
 * injectable so tests never touch the real filesystem. Loading never throws:
 * missing files yield defaults silently, unreadable or invalid files yield
 * defaults plus an error `ConfigIssue`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseConfig, type ConfigIssue, type PluginConfig } from '../domain/config'

/** Environment variable that overrides the config file location. */
export const CONFIG_ENV_VAR = 'OPENCODE_AGENT_FALLBACK_CONFIG'

/** Project-relative location, under the opencode config directory. */
export const PROJECT_CONFIG_PATH = join('.opencode', 'agent-fallback.json')

/** User-level location, under the opencode config directory. */
export const USER_CONFIG_PATH = join('.config', 'opencode', 'agent-fallback.json')

export type ConfigLoaderDeps = {
	/** Project directory the plugin was loaded for. */
	projectDirectory: string
	env: (key: string) => string | undefined
	homedir: () => string
	exists: (path: string) => boolean
	read: (path: string) => string
}

export type LoadedConfig = {
	config: PluginConfig
	issues: ConfigIssue[]
	/** Resolved file path, or `null` when no file exists (defaults in use). */
	path: string | null
}

/** Real filesystem/environment dependencies for the given project directory. */
export function defaultConfigLoaderDeps(projectDirectory: string): ConfigLoaderDeps {
	return {
		projectDirectory,
		env: (key) => process.env[key],
		homedir,
		exists: (path) => existsSync(path),
		read: (path) => readFileSync(path, 'utf8')
	}
}

/**
 * Resolution order, first existing file wins:
 * 1. `$OPENCODE_AGENT_FALLBACK_CONFIG`
 * 2. `<project>/.opencode/agent-fallback.json`
 * 3. `~/.config/opencode/agent-fallback.json`
 */
export function resolveConfigPath(deps: ConfigLoaderDeps): string | null {
	const candidates: Array<string> = []
	const fromEnv = deps.env(CONFIG_ENV_VAR)
	if (typeof fromEnv === 'string' && fromEnv.length > 0) candidates.push(fromEnv)
	candidates.push(join(deps.projectDirectory, PROJECT_CONFIG_PATH))
	candidates.push(join(deps.homedir(), USER_CONFIG_PATH))

	for (const candidate of candidates) {
		try {
			if (deps.exists(candidate)) return candidate
		} catch {
			// A path we cannot even stat is treated as absent; keep resolving.
		}
	}
	return null
}

/** Load the plugin config. Never throws. */
export function loadConfig(deps: ConfigLoaderDeps): LoadedConfig {
	const path = resolveConfigPath(deps)
	if (path === null) {
		const { config, issues } = parseConfig(undefined)
		return { config, issues, path: null }
	}

	let text: string
	try {
		text = deps.read(path)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		const { config, issues } = parseConfig(undefined)
		return {
			config,
			issues: [...issues, { severity: 'error', path, message: `cannot read config: ${message}` }],
			path
		}
	}

	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		const { config, issues } = parseConfig(undefined)
		return {
			config,
			issues: [...issues, { severity: 'error', path, message: `invalid JSON: ${message}` }],
			path
		}
	}

	const { config, issues } = parseConfig(raw)
	return { config, issues, path }
}

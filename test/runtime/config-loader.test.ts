import { describe, expect, test } from 'bun:test'
import { CONFIG_ENV_VAR, loadConfig, resolveConfigPath, type ConfigLoaderDeps } from '../../src/runtime/config-loader'

type Overrides = Partial<ConfigLoaderDeps> & { files?: Record<string, string | Error> }

function makeDeps(overrides: Overrides = {}): ConfigLoaderDeps {
	const files = overrides.files ?? {}
	return {
		projectDirectory: overrides.projectDirectory ?? '/project',
		env: overrides.env ?? (() => undefined),
		homedir: overrides.homedir ?? (() => '/home/user'),
		exists: overrides.exists ?? ((path: string) => path in files),
		read:
			overrides.read ??
			((path: string) => {
				const value = files[path]
				if (value === undefined) throw new Error(`ENOENT: ${path}`)
				if (value instanceof Error) throw value
				return value
			})
	}
}

const PROJECT_PATH = '/project/.opencode/agent-fallback.json'
const HOME_PATH = '/home/user/.config/opencode/agent-fallback.json'

describe('resolveConfigPath', () => {
	test('prefers the environment variable when its file exists', () => {
		const deps = makeDeps({
			env: (key) => (key === CONFIG_ENV_VAR ? '/custom/fallback.json' : undefined),
			files: { '/custom/fallback.json': '{}', [PROJECT_PATH]: '{}', [HOME_PATH]: '{}' }
		})
		expect(resolveConfigPath(deps)).toBe('/custom/fallback.json')
	})

	test('falls through to the project path when the env file is missing', () => {
		const deps = makeDeps({
			env: (key) => (key === CONFIG_ENV_VAR ? '/missing/fallback.json' : undefined),
			files: { [PROJECT_PATH]: '{}', [HOME_PATH]: '{}' }
		})
		expect(resolveConfigPath(deps)).toBe(PROJECT_PATH)
	})

	test('falls through to the home path when no earlier file exists', () => {
		const deps = makeDeps({ files: { [HOME_PATH]: '{}' } })
		expect(resolveConfigPath(deps)).toBe(HOME_PATH)
	})

	test('treats an empty env value as unset', () => {
		const deps = makeDeps({
			env: (key) => (key === CONFIG_ENV_VAR ? '' : undefined),
			files: { [PROJECT_PATH]: '{}' }
		})
		expect(resolveConfigPath(deps)).toBe(PROJECT_PATH)
	})

	test('returns null when no config file exists anywhere', () => {
		expect(resolveConfigPath(makeDeps())).toBeNull()
	})
})

describe('loadConfig', () => {
	test('returns defaults with no issues when no file exists', () => {
		const { config, issues, path } = loadConfig(makeDeps())
		expect(path).toBeNull()
		expect(issues).toEqual([])
		expect(config.enabled).toBe(true)
		expect(config.default).toEqual([])
		expect(config.agents).toEqual({})
	})

	test('loads and parses the resolved file', () => {
		const deps = makeDeps({ files: { [PROJECT_PATH]: '{"default":["prov/m1"],"enabled":false}' } })
		const { config, issues, path } = loadConfig(deps)
		expect(path).toBe(PROJECT_PATH)
		expect(issues).toEqual([])
		expect(config.enabled).toBe(false)
		expect(config.default).toEqual([{ model: 'prov/m1' }])
	})

	test('invalid JSON yields defaults plus an error issue, never a throw', () => {
		const deps = makeDeps({ files: { [PROJECT_PATH]: '{not json' } })
		const { config, issues, path } = loadConfig(deps)
		expect(path).toBe(PROJECT_PATH)
		expect(config).toEqual(loadConfig(makeDeps()).config)
		expect(issues).toHaveLength(1)
		expect(issues[0]?.severity).toBe('error')
		expect(issues[0]?.path).toBe(PROJECT_PATH)
		expect(issues[0]?.message).toContain('invalid JSON')
	})

	test('an unreadable file yields defaults plus an error issue, never a throw', () => {
		const deps = makeDeps({
			files: { [HOME_PATH]: new Error('EACCES: permission denied') }
		})
		const { config, issues, path } = loadConfig(deps)
		expect(path).toBe(HOME_PATH)
		expect(config.default).toEqual([])
		expect(issues).toHaveLength(1)
		expect(issues[0]?.severity).toBe('error')
		expect(issues[0]?.path).toBe(HOME_PATH)
		expect(issues[0]?.message).toContain('EACCES')
	})

	test('parse-level issues from the file are preserved', () => {
		const deps = makeDeps({ files: { [PROJECT_PATH]: '{"default":["no-slash"],"surprise":1}' } })
		const { issues } = loadConfig(deps)
		expect(issues.map((issue) => issue.path).sort()).toEqual(['default[0]', 'surprise'])
	})

	test('the env-configured file wins end to end', () => {
		const deps = makeDeps({
			env: (key) => (key === CONFIG_ENV_VAR ? '/custom/fallback.json' : undefined),
			files: {
				'/custom/fallback.json': '{"enabled":false}',
				[PROJECT_PATH]: '{"enabled":true}'
			}
		})
		const { config, path } = loadConfig(deps)
		expect(path).toBe('/custom/fallback.json')
		expect(config.enabled).toBe(false)
	})
})

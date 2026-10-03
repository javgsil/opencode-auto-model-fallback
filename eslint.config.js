import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	{ ignores: ['spike/**', '.atl/**', 'node_modules/**', 'dist/**'] },
	{
		files: ['**/*.{js,ts}'],
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		rules: {
			'@typescript-eslint/no-explicit-any': 'error'
		}
	}
)

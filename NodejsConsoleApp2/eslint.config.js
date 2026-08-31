// ESLint flat config (supported by eslint 8.57) for this plain Node.js
// CommonJS console app. No Qwik/Vue plugins are added: the scanner's
// framework-specific findings ("wrap with $()", "Enforce Prettier in Vue",
// "Non-HTML function returns HTML") are false positives for a plain Node app.
'use strict';

module.exports = [
    {
        files: ['app.js', 'brokenStreams.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                // Node.js built-in globals used by app.js
                fetch: 'readonly',
                URL: 'readonly',
                AbortController: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                console: 'readonly',
                process: 'readonly',
                require: 'readonly',
                module: 'writable',
                exports: 'writable',
                __dirname: 'readonly',
                __filename: 'readonly',
                Buffer: 'readonly',
                Date: 'readonly',
                Promise: 'readonly',
                Map: 'readonly',
                Set: 'readonly',
            },
        },
        rules: {
            // eslint:recommended baseline
            'no-undef': 'error',
            'no-unused-vars': 'error',
            'no-constant-condition': 'error',
            'no-dupe-keys': 'error',
            'no-unreachable': 'error',
            'no-empty': 'error',
            'no-extra-boolean-cast': 'error',
            'valid-typeof': 'error',
            // Stylistic rules so `--fix` normalizes the scan findings
            quotes: ['error', 'double', { avoidEscape: true }],
            indent: ['error', 4],
            'prefer-const': 'error',
            radix: 'error',
            'prefer-exponentiation-operator': 'error',
            'dot-notation': 'error',
            'no-lonely-if': 'error',
            'comma-dangle': ['error', 'always-multiline'],
        },
    },
];

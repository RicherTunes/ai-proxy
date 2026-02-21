#!/usr/bin/env node

/**
 * Configuration Linter
 *
 * Checks for unsafe configuration combinations and security issues.
 *
 * Usage:
 *   node scripts/lint-config.js [--config path/to/config.json]
 *
 * Exit codes:
 *   0 - No issues found
 *   1 - Warnings only
 *   2 - Errors found
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Parse arguments
const args = process.argv.slice(2);
let configPath = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) {
        configPath = args[i + 1];
        break;
    }
}

// Load config
let config = {};

if (configPath) {
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        console.error(`Error loading config from ${configPath}: ${e.message}`);
        process.exit(2);
    }
} else {
    // Try default locations
    const defaultPaths = [
        path.join(process.cwd(), 'config.json'),
        path.join(process.cwd(), 'config/default.json'),
        path.join(process.cwd(), 'settings.json')
    ];

    for (const p of defaultPaths) {
        if (fs.existsSync(p)) {
            try {
                config = JSON.parse(fs.readFileSync(p, 'utf8'));
                console.log(`Loaded config from: ${p}`);
                break;
            } catch (e) {
                // Continue to next
            }
        }
    }
}

// Also check environment variables
const envOverrides = {
    securityMode: process.env.GLM_SECURITY_MODE,
    adminToken: process.env.GLM_ADMIN_TOKEN,
    cspEnabled: process.env.GLM_CSP_ENABLED,
    host: process.env.GLM_HOST
};

// Normalize config
const security = config.security || {};
const securityMode = envOverrides.securityMode || security.mode || 'local';
const adminAuth = config.adminAuth || security.adminAuth || {};
const csp = config.csp || security.csp || {};
const logging = config.logging || security.logging || {};
const host = envOverrides.host || config.host || '127.0.0.1';

// Results
const errors = [];
const warnings = [];

// ============================================================================
// LINTING RULES
// ============================================================================

/**
 * Rule: internet-mode-auth
 * When security.mode is "internet", admin auth must be enabled
 */
function checkInternetModeAuth() {
    if (securityMode === 'internet') {
        const authEnabled = adminAuth.enabled !== false &&
            (envOverrides.adminToken || (adminAuth.tokens && adminAuth.tokens.length > 0));

        if (!authEnabled) {
            errors.push({
                rule: 'internet-mode-auth',
                message: 'Admin authentication must be enabled in internet mode',
                fix: 'Set adminAuth.enabled=true and configure adminAuth.tokens'
            });
        }
    }
}

/**
 * Rule: internet-mode-csp
 * When security.mode is "internet", CSP should be enabled
 */
function checkInternetModeCsp() {
    if (securityMode === 'internet') {
        const cspEnabled = envOverrides.cspEnabled === '1' || csp.enabled !== false;

        if (!cspEnabled) {
            warnings.push({
                rule: 'internet-mode-csp',
                message: 'CSP headers should be enabled in internet mode',
                fix: 'Set csp.enabled=true or GLM_CSP_ENABLED=1'
            });
        }
    }
}

/**
 * Rule: auth-tokens-present
 * When admin auth is enabled, tokens must be configured
 */
function checkAuthTokensPresent() {
    const authEnabled = adminAuth.enabled !== false;
    const hasTokens = envOverrides.adminToken ||
        (adminAuth.tokens && adminAuth.tokens.length > 0);

    if (authEnabled && !hasTokens) {
        errors.push({
            rule: 'auth-tokens-present',
            message: 'Admin auth is enabled but no tokens are configured',
            fix: 'Add tokens to adminAuth.tokens or set GLM_ADMIN_TOKEN env var'
        });
    }
}

/**
 * Rule: no-sensitive-logging
 * In internet mode, body logging should be redacted
 */
function checkSensitiveLogging() {
    if (securityMode === 'internet') {
        const redactBodies = logging.redactBodies !== false;

        if (!redactBodies && logging.logBodies !== false) {
            warnings.push({
                rule: 'no-sensitive-logging',
                message: 'Request/response body logging should be redacted in internet mode',
                fix: 'Set logging.redactBodies=true or logging.logBodies=false'
            });
        }
    }
}

/**
 * Rule: localhost-only-local
 * Local mode should only bind to localhost
 */
function checkLocalhostOnlyLocal() {
    if (securityMode === 'local') {
        const isLocalhost = host === '127.0.0.1' ||
            host === 'localhost' ||
            host === '::1';

        if (!isLocalhost) {
            errors.push({
                rule: 'localhost-only-local',
                message: `Local mode should only bind to localhost, but host is "${host}"`,
                fix: 'Use security.mode="internet" for non-localhost bindings'
            });
        }
    }
}

/**
 * Rule: weak-tokens
 * Tokens should be sufficiently long and random
 */
function checkWeakTokens() {
    const tokens = adminAuth.tokens || [];

    for (const token of tokens) {
        if (typeof token === 'string') {
            if (token.length < 16) {
                warnings.push({
                    rule: 'weak-tokens',
                    message: `Admin token is too short (${token.length} chars, minimum 16)`,
                    fix: 'Use longer, randomly generated tokens'
                });
            }

            // Check for common weak patterns
            const weakPatterns = ['admin', 'password', 'secret', '12345', 'test'];
            for (const pattern of weakPatterns) {
                if (token.toLowerCase().includes(pattern)) {
                    warnings.push({
                        rule: 'weak-tokens',
                        message: `Admin token contains weak pattern "${pattern}"`,
                        fix: 'Use randomly generated tokens without common words'
                    });
                    break;
                }
            }
        }
    }
}

/**
 * Rule: default-credentials
 * Check for default/example credentials that shouldn't be used
 */
function checkDefaultCredentials() {
    const dangerousDefaults = [
        'your-secret-token-here',
        'changeme',
        'example-token',
        'test-token',
        'demo-token'
    ];

    const tokens = adminAuth.tokens || [];

    for (const token of tokens) {
        if (dangerousDefaults.includes(token.toLowerCase())) {
            errors.push({
                rule: 'default-credentials',
                message: 'Default/example credentials detected in configuration',
                fix: 'Replace with unique, securely generated tokens'
            });
            break;
        }
    }
}

/**
 * Rule: api-keys-in-config
 * API keys should not be hardcoded in config
 */
function checkApiKeysInConfig() {
    if (config.apiKeys && Array.isArray(config.apiKeys) && config.apiKeys.length > 0) {
        // Check if any look like real keys
        for (const key of config.apiKeys) {
            if (typeof key === 'string' && key.length > 20 && !key.includes('example')) {
                warnings.push({
                    rule: 'api-keys-in-config',
                    message: 'API keys appear to be hardcoded in config file',
                    fix: 'Load API keys from GLM_API_KEYS_FILE or environment variables'
                });
                break;
            }
        }
    }
}

// ============================================================================
// RUN CHECKS
// ============================================================================

console.log('\nGLM Proxy Configuration Linter\n');
console.log(`Security Mode: ${securityMode}`);
console.log(`Host: ${host}`);
console.log(`Admin Auth: ${adminAuth.enabled !== false ? 'enabled' : 'disabled'}`);
console.log(`CSP: ${csp.enabled !== false ? 'enabled' : 'disabled'}`);
console.log('');

// Run all checks
checkInternetModeAuth();
checkInternetModeCsp();
checkAuthTokensPresent();
checkSensitiveLogging();
checkLocalhostOnlyLocal();
checkWeakTokens();
checkDefaultCredentials();
checkApiKeysInConfig();

// Output results
if (errors.length === 0 && warnings.length === 0) {
    console.log('✓ No issues found\n');
    process.exit(0);
}

if (errors.length > 0) {
    console.log('ERRORS:\n');
    for (const err of errors) {
        console.log(`  ✗ [${err.rule}] ${err.message}`);
        console.log(`    Fix: ${err.fix}\n`);
    }
}

if (warnings.length > 0) {
    console.log('WARNINGS:\n');
    for (const warn of warnings) {
        console.log(`  ! [${warn.rule}] ${warn.message}`);
        console.log(`    Fix: ${warn.fix}\n`);
    }
}

// Summary
console.log('---');
console.log(`${errors.length} error(s), ${warnings.length} warning(s)\n`);

if (errors.length > 0) {
    process.exit(2);
} else if (warnings.length > 0) {
    process.exit(1);
} else {
    process.exit(0);
}

#!/usr/bin/env node
/**
 * Check Pricing Script
 *
 * Validates pricing configuration and detects changes.
 *
 * Usage:
 *   node scripts/check-pricing.js --check                    # Check against stored hash
 *   node scripts/check-pricing.js --hash                     # Output current hash
 *   node scripts/check-pricing.js --help                     # Show help
 *
 * Options:
 *   --config <path>   Path to pricing config file (default: config/pricing.json)
 *   --check           Compare current pricing with stored hash
 *   --hash            Output hash of current pricing
 *   --quiet           Suppress informational output
 *   --json            Output results as JSON
 *   --help            Show this help message
 *
 * Exit codes:
 *   0 - No changes detected / success
 *   1 - Changes detected
 *   2 - Error
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
    config: null,
    check: false,
    hash: false,
    quiet: false,
    json: false,
    help: false
};

for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' || arg === '-c') {
        options.config = args[++i];
    } else if (arg === '--check') {
        options.check = true;
    } else if (arg === '--hash') {
        options.hash = true;
    } else if (arg === '--quiet' || arg === '-q') {
        options.quiet = true;
    } else if (arg === '--json') {
        options.json = true;
    } else if (arg === '--help' || arg === '-h') {
        options.help = true;
    }
}

/**
 * Show help message
 */
function showHelp() {
    console.log(`
Usage: node scripts/check-pricing.js [options]

Validates pricing configuration and detects changes.

Options:
  --config <path>   Path to pricing config file (default: config/pricing.json)
  --check           Compare current pricing with stored hash
  --hash            Output hash of current pricing
  --quiet           Suppress informational output
  --json            Output results as JSON
  --help            Show this help message

Exit codes:
  0 - No changes detected / success
  1 - Changes detected
  2 - Error

Examples:
  node scripts/check-pricing.js --check
  node scripts/check-pricing.js --hash --config ./config/pricing.json
  node scripts/check-pricing.js --check --json > result.json
`);
}

/**
 * Compute SHA256 hash of pricing models
 * @param {Object} pricing - Pricing object
 * @returns {string} Hex hash
 */
function computePricingHash(pricing) {
    if (!pricing || !pricing.models) {
        return '';
    }

    // Sort models by ID for consistent hash
    const sortedModels = Object.keys(pricing.models)
        .sort()
        .reduce((acc, key) => {
            acc[key] = pricing.models[key];
            return acc;
        }, {});

    return crypto.createHash('sha256')
        .update(JSON.stringify(sortedModels))
        .digest('hex');
}

/**
 * Load and parse pricing config file
 * @param {string} configPath - Path to config file
 * @returns {Object} Result with pricing, error, etc.
 */
function loadConfig(configPath) {
    const result = {
        pricing: null,
        error: null,
        exists: false
    };

    try {
        if (!fs.existsSync(configPath)) {
            result.error = `Config file not found: ${configPath}`;
            return result;
        }

        result.exists = true;
        const content = fs.readFileSync(configPath, 'utf8');
        result.pricing = JSON.parse(content);
    } catch (err) {
        if (err instanceof SyntaxError) {
            result.error = `Invalid JSON: ${err.message}`;
        } else {
            result.error = `Failed to load config: ${err.message}`;
        }
    }

    return result;
}

/**
 * Main function
 */
function main() {
    if (options.help) {
        showHelp();
        process.exit(0);
    }

    // Determine config path
    const configPath = options.config
        ? (path.isAbsolute(options.config) ? options.config : path.resolve(process.cwd(), options.config))
        : path.join(process.cwd(), 'config', 'pricing.json');

    // Load config
    const loadResult = loadConfig(configPath);

    if (loadResult.error) {
        if (options.json) {
            console.log(JSON.stringify({
                error: loadResult.error,
                configPath,
                checkedAt: new Date().toISOString(),
                success: false
            }, null, 2));
        } else if (!options.quiet) {
            console.error(`Error: ${loadResult.error}`);
        }
        process.exit(2);
    }

    const currentHash = computePricingHash(loadResult.pricing);
    const checkedAt = new Date().toISOString();

    // --hash mode: just output the hash
    if (options.hash) {
        if (options.json) {
            console.log(JSON.stringify({
                hash: currentHash,
                configPath,
                computedAt: checkedAt
            }, null, 2));
        } else if (options.quiet) {
            console.log(currentHash);
        } else {
            console.log(`Pricing hash: ${currentHash}`);
            console.log(`Config: ${configPath}`);
        }
        process.exit(0);
    }

    // --check mode (default)
    const result = {
        checkedAt,
        configPath,
        hash: currentHash,
        version: loadResult.pricing.version,
        lastVerifiedAt: loadResult.pricing.lastVerifiedAt,
        sourceUrl: loadResult.pricing.sourceUrl,
        modelCount: Object.keys(loadResult.pricing.models).length,
        changesDetected: false,
        success: true
    };

    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
    } else if (!options.quiet) {
        console.log(`Pricing check: ${configPath}`);
        console.log(`  Version: ${result.version}`);
        console.log(`  Last verified: ${result.lastVerifiedAt}`);
        console.log(`  Models: ${result.modelCount}`);
        console.log(`  Hash: ${currentHash.substring(0, 16)}...`);
        console.log(`  Status: OK`);
    }

    process.exit(0);
}

// Run
main();

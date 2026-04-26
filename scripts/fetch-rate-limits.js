#!/usr/bin/env node
/**
 * Fetch z.ai rate limits via their internal web API.
 *
 * Usage:
 *   1. Log into z.ai in your browser
 *   2. Open DevTools → Application → Local Storage → z.ai
 *   3. Copy the value of "z-ai-open-platform-token-production"
 *   4. Run:  node scripts/fetch-rate-limits.js <TOKEN>
 *      or:   Z_AI_WEB_TOKEN=<TOKEN> node scripts/fetch-rate-limits.js
 *
 * The script will print the per-model concurrency/RPM limits
 * and optionally update model-discovery.js static values.
 */

const https = require('https');

const TOKEN = process.argv[2] || process.env.Z_AI_WEB_TOKEN;

if (!TOKEN) {
    console.error('Usage: node scripts/fetch-rate-limits.js <WEB_SESSION_TOKEN>');
    console.error('');
    console.error('To get your web session token:');
    console.error('  1. Log into https://z.ai/manage-apikey/rate-limits');
    console.error('  2. Open DevTools → Application → Local Storage → z.ai');
    console.error('  3. Copy "z-ai-open-platform-token-production"');
    process.exit(1);
}

// The z.ai web portal uses this internal endpoint
const API_BASE = 'https://api.z.ai/api';
const ENDPOINT = '/biz/customer/speed/config/queryCustomerRpm';

function fetchRateLimits(customerId) {
    const url = customerId
        ? `${API_BASE}${ENDPOINT}?customerId=${encodeURIComponent(customerId)}`
        : `${API_BASE}${ENDPOINT}`;

    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'Authorization': `Bearer ${TOKEN}`,
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json);
                } catch (e) {
                    reject(new Error(`Failed to parse response: ${data.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function main() {
    console.log('Fetching rate limits from z.ai web portal...\n');

    try {
        // Try without customerId first (may return data for authenticated user)
        const result = await fetchRateLimits();

        if (result.code === 1001) {
            console.error('Auth failed. Token may be expired. Please get a fresh token from z.ai.');
            process.exit(1);
        }

        if (result.code !== 0 && result.code !== 200 && !result.success) {
            console.error('API error:', result.msg || JSON.stringify(result));

            // If it needs customerId, try to extract from a different endpoint
            if (result.msg && result.msg.includes('customerId')) {
                console.error('\nThe endpoint requires a customerId parameter.');
                console.error('Check the z.ai dashboard for your customer ID.');
            }
            process.exit(1);
        }

        const models = result.data?.modelRuleList || result.data || [];

        if (!Array.isArray(models) || models.length === 0) {
            console.log('Response:', JSON.stringify(result, null, 2));
            console.log('\nNo model rules found. The response format may have changed.');
            process.exit(0);
        }

        // Display results
        console.log('Model Rate Limits:');
        console.log('─'.repeat(60));
        console.log(`${'Model'.padEnd(25)} ${'Type'.padEnd(15)} ${'Concurrency/RPM'.padEnd(15)}`);
        console.log('─'.repeat(60));

        for (const model of models) {
            const name = model.modelName || model.model || model.name || 'unknown';
            const type = model.modelType || model.type || '';
            const limit = model.rpm || model.concurrency || model.limit || '?';
            console.log(`${name.padEnd(25)} ${type.padEnd(15)} ${String(limit).padEnd(15)}`);
        }

        console.log('─'.repeat(60));
        console.log(`\nTotal models: ${models.length}`);

        // Output as JSON for piping
        if (process.argv.includes('--json')) {
            console.log('\nJSON output:');
            console.log(JSON.stringify(models, null, 2));
        }

    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

main();

#!/usr/bin/env node
'use strict';

/**
 * Z.AI Model Concurrency Stress Test
 *
 * Discovers the actual per-model concurrent request limit by sending
 * parallel requests to each model and observing 429 thresholds.
 *
 * Usage:
 *   node scripts/stress-test-concurrency.js [options]
 *
 * Options:
 *   --models <list>       Comma-separated models to test (default: all chat models)
 *   --max-parallel <n>    Max parallel requests to attempt (default: 10)
 *   --key-index <n>       Which API key to use, 0-based (default: 0)
 *   --key <value>         Use a specific API key directly
 *   --base-url <url>      API base URL (default: from api-keys.json)
 *   --delay <ms>          Delay between test rounds (default: 3000)
 *   --prompt <text>       Prompt to send (default: short "hi")
 *   --max-tokens <n>      Max tokens in response (default: 1)
 *   --dry-run             Print plan without sending requests
 *   --verbose             Show individual request results
 *   --rounds <n>          Repeat each concurrency level N times (default: 2)
 *   --multi-key           Test if concurrency is per-key or per-account:
 *                         sends requests spread across multiple keys at the
 *                         concurrency limit to see if different keys share quota
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── Parse CLI args ──────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        models: null,
        maxParallel: 10,
        keyIndex: 0,
        key: null,
        baseUrl: null,
        delay: 3000,
        prompt: 'Reply with exactly one word: "ok"',
        maxTokens: 1,
        dryRun: false,
        verbose: false,
        rounds: 2,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--models':     opts.models = args[++i].split(',').map(s => s.trim()); break;
            case '--max-parallel': opts.maxParallel = parseInt(args[++i], 10); break;
            case '--key-index':  opts.keyIndex = parseInt(args[++i], 10); break;
            case '--key':        opts.key = args[++i]; break;
            case '--base-url':   opts.baseUrl = args[++i]; break;
            case '--delay':      opts.delay = parseInt(args[++i], 10); break;
            case '--prompt':     opts.prompt = args[++i]; break;
            case '--max-tokens': opts.maxTokens = parseInt(args[++i], 10); break;
            case '--dry-run':    opts.dryRun = true; break;
            case '--verbose':    opts.verbose = true; break;
            case '--rounds':     opts.rounds = parseInt(args[++i], 10); break;
            case '--multi-key':  opts.multiKey = true; break;
            case '--help':
                console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1]);
                process.exit(0);
        }
    }
    return opts;
}

// ── Load keys ───────────────────────────────────────────────────────────

function loadConfig(opts) {
    const keysPath = path.join(__dirname, '..', 'api-keys.json');
    if (!fs.existsSync(keysPath)) {
        console.error('Error: api-keys.json not found at', keysPath);
        process.exit(1);
    }

    const keysData = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
    const apiKey = opts.key || keysData.keys[opts.keyIndex];
    const baseUrl = opts.baseUrl || keysData.baseUrl || 'https://api.z.ai/api/anthropic';

    if (!apiKey) {
        console.error(`Error: No API key at index ${opts.keyIndex}. Available: ${keysData.keys.length} keys`);
        process.exit(1);
    }

    return { apiKey, baseUrl, totalKeys: keysData.keys.length, allKeys: keysData.keys };
}

// ── Load model metadata ─────────────────────────────────────────────────

function loadModels(opts) {
    const { KNOWN_GLM_MODELS } = require(path.join(__dirname, '..', 'lib', 'model-discovery'));

    const chatModels = KNOWN_GLM_MODELS.filter(m => m.type === 'chat' && m.supportsStreaming);

    if (opts.models) {
        return chatModels.filter(m => opts.models.includes(m.id));
    }

    return chatModels;
}

// ── HTTP request helper ─────────────────────────────────────────────────

function makeRequest(baseUrl, apiKey, model, prompt, maxTokens, timeoutMs = 30000) {
    return new Promise((resolve) => {
        const url = new URL(baseUrl + '/v1/messages');
        const isHttps = url.protocol === 'https:';
        const transport = isHttps ? https : http;

        const body = JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            stream: false,
        });

        const startTime = Date.now();

        const reqOpts = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-length': Buffer.byteLength(body),
            },
            timeout: timeoutMs,
        };

        const req = transport.request(reqOpts, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const elapsed = Date.now() - startTime;
                const rawBody = Buffer.concat(chunks).toString();
                let parsedBody = null;
                try { parsedBody = JSON.parse(rawBody); } catch { /* ignore */ }

                const retryAfter = res.headers['retry-after'];

                resolve({
                    status: res.statusCode,
                    elapsed,
                    retryAfter: retryAfter ? parseInt(retryAfter, 10) : null,
                    body: parsedBody,
                    rawBody: rawBody.substring(0, 500),
                    is429: res.statusCode === 429,
                    isSuccess: res.statusCode >= 200 && res.statusCode < 300,
                    isError: res.statusCode >= 400,
                });
            });
        });

        req.on('error', (err) => {
            resolve({
                status: 0,
                elapsed: Date.now() - startTime,
                error: err.message,
                is429: false,
                isSuccess: false,
                isError: true,
            });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({
                status: 0,
                elapsed: Date.now() - startTime,
                error: 'timeout',
                is429: false,
                isSuccess: false,
                isError: true,
            });
        });

        req.write(body);
        req.end();
    });
}

// ── Stress test a single model ──────────────────────────────────────────

async function testModelConcurrency(model, config, opts) {
    const { apiKey, baseUrl } = config;
    const results = {
        model: model.id,
        maxConcurrencyMetadata: model.maxConcurrency,
        rounds: [],
        maxObservedConcurrency: 0,
        firstReject429At: null,      // First concurrency level that got a 429
        consistentReject429At: null,  // Concurrency level where ALL rounds got 429s
    };

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing: ${model.id} (metadata maxConc: ${model.maxConcurrency})`);
    console.log(`${'='.repeat(60)}`);

    // Test concurrency levels from 1 up to maxParallel
    for (let concurrency = 1; concurrency <= opts.maxParallel; concurrency++) {
        const roundResults = [];

        for (let round = 0; round < opts.rounds; round++) {
            if (opts.dryRun) {
                console.log(`  [DRY RUN] Would send ${concurrency} parallel requests (round ${round + 1}/${opts.rounds})`);
                roundResults.push({ concurrency, successes: concurrency, failures429: 0, otherErrors: 0 });
                continue;
            }

            // Fire N requests simultaneously
            const promises = [];
            for (let i = 0; i < concurrency; i++) {
                promises.push(makeRequest(baseUrl, apiKey, model.id, opts.prompt, opts.maxTokens));
            }

            const responses = await Promise.all(promises);

            const successes = responses.filter(r => r.isSuccess).length;
            const failures429 = responses.filter(r => r.is429).length;
            const otherErrors = responses.filter(r => r.isError && !r.is429).length;
            const avgElapsed = Math.round(responses.reduce((s, r) => s + r.elapsed, 0) / responses.length);

            const roundResult = {
                concurrency,
                round: round + 1,
                successes,
                failures429,
                otherErrors,
                avgElapsed,
                responses: opts.verbose ? responses : undefined,
            };
            roundResults.push(roundResult);

            // Status indicator
            const icon = failures429 > 0 ? '\u2717' : '\u2713';
            const color429 = failures429 > 0 ? '\x1b[31m' : '\x1b[32m';
            console.log(`  ${color429}${icon}\x1b[0m  concurrency=${concurrency} round=${round + 1}/${opts.rounds}: ${successes} ok, ${failures429} 429s, ${otherErrors} errors (avg ${avgElapsed}ms)`);

            if (opts.verbose && failures429 > 0) {
                responses.filter(r => r.is429).forEach(r => {
                    console.log(`     429 detail: retryAfter=${r.retryAfter}s body=${r.rawBody?.substring(0, 200)}`);
                });
            }

            // Brief pause between rounds to let rate limits reset
            if (round < opts.rounds - 1) {
                await sleep(1000);
            }
        }

        // Analyze this concurrency level
        const any429 = roundResults.some(r => r.failures429 > 0);
        const all429 = roundResults.every(r => r.failures429 > 0);

        results.rounds.push({
            concurrency,
            any429,
            all429,
            details: roundResults,
        });

        if (!any429) {
            results.maxObservedConcurrency = concurrency;
        }

        if (any429 && !results.firstReject429At) {
            results.firstReject429At = concurrency;
        }

        if (all429 && !results.consistentReject429At) {
            results.consistentReject429At = concurrency;
        }

        // If we got consistent 429s at this level and two levels above, stop early
        if (results.consistentReject429At && concurrency >= results.consistentReject429At + 2) {
            console.log(`  >> Early stop: consistent 429s since concurrency=${results.consistentReject429At}`);
            break;
        }

        // Wait between concurrency levels
        if (concurrency < opts.maxParallel) {
            await sleep(opts.delay);
        }
    }

    return results;
}

// ── Multi-key test: per-key vs per-account limits ───────────────────────

async function testMultiKeyConcurrency(model, allKeys, baseUrl, opts) {
    // Strategy: first discover single-key limit, then test if spreading
    // across N keys allows more total concurrency.
    //
    // If per-KEY: 2 keys should allow 2x the single-key limit
    // If per-ACCOUNT: 2 keys still hit the same limit as 1 key

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Multi-Key Test: ${model.id}`);
    console.log(`${'='.repeat(60)}`);

    const keysToTest = Math.min(allKeys.length, 5); // Test up to 5 keys
    const singleKeyLimit = model.maxConcurrency; // Use metadata as starting point

    // Phase 1: Find single-key limit with first key
    console.log(`\n  Phase 1: Single-key limit (key #0: ${allKeys[0].substring(0, 8)}...)`);
    let singleMax = 0;
    for (let c = 1; c <= Math.min(opts.maxParallel, 6); c++) {
        if (opts.dryRun) {
            console.log(`    [DRY RUN] ${c} parallel with 1 key`);
            singleMax = c;
            continue;
        }

        const promises = [];
        for (let i = 0; i < c; i++) {
            promises.push(makeRequest(baseUrl, allKeys[0], model.id, opts.prompt, opts.maxTokens));
        }
        const responses = await Promise.all(promises);
        const got429 = responses.some(r => r.is429);
        const successes = responses.filter(r => r.isSuccess).length;

        const icon = got429 ? '\u2717' : '\u2713';
        const color = got429 ? '\x1b[31m' : '\x1b[32m';
        console.log(`    ${color}${icon}\x1b[0m  1 key x ${c} parallel: ${successes} ok, ${responses.filter(r => r.is429).length} 429s`);

        if (!got429) singleMax = c;
        if (got429) break;

        await sleep(opts.delay);
    }

    console.log(`    >> Single-key max: ${singleMax}`);

    // Phase 2: Spread same total across multiple keys
    const testConcurrency = Math.max(singleMax + 1, 2); // Go above single-key limit
    console.log(`\n  Phase 2: Multi-key test at concurrency=${testConcurrency}`);

    const multiKeyResults = [];

    for (let numKeys = 1; numKeys <= keysToTest; numKeys++) {
        if (opts.dryRun) {
            console.log(`    [DRY RUN] ${testConcurrency} parallel spread across ${numKeys} keys`);
            multiKeyResults.push({ numKeys, successes: testConcurrency, failures429: 0 });
            continue;
        }

        // Spread requests round-robin across keys
        const promises = [];
        for (let i = 0; i < testConcurrency; i++) {
            const keyIdx = i % numKeys;
            promises.push(makeRequest(baseUrl, allKeys[keyIdx], model.id, opts.prompt, opts.maxTokens));
        }
        const responses = await Promise.all(promises);
        const successes = responses.filter(r => r.isSuccess).length;
        const failures429 = responses.filter(r => r.is429).length;

        const icon = failures429 > 0 ? '\u2717' : '\u2713';
        const color = failures429 > 0 ? '\x1b[31m' : '\x1b[32m';
        console.log(`    ${color}${icon}\x1b[0m  ${numKeys} key(s) x ${testConcurrency} total: ${successes} ok, ${failures429} 429s`);

        multiKeyResults.push({ numKeys, successes, failures429, total: testConcurrency });

        await sleep(opts.delay);
    }

    // Analyze: if more keys doesn't help, it's account-level
    const oneKeyResult = multiKeyResults.find(r => r.numKeys === 1);
    const multiResults = multiKeyResults.filter(r => r.numKeys > 1);
    const multiKeyHelps = multiResults.some(r => r.successes > (oneKeyResult?.successes || 0));

    const conclusion = multiKeyHelps
        ? 'PER-KEY: More keys allow more concurrency'
        : 'PER-ACCOUNT: Keys share the same concurrency quota';

    console.log(`\n    >> Conclusion: ${conclusion}`);

    return {
        model: model.id,
        singleKeyMax: singleMax,
        testConcurrency,
        multiKeyResults,
        conclusion,
        isPerAccount: !multiKeyHelps,
    };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
    const opts = parseArgs();
    const config = loadConfig(opts);
    const models = loadModels(opts);

    console.log('Z.AI Model Concurrency Stress Test');
    console.log('==================================');
    console.log(`API Key: ${config.apiKey.substring(0, 8)}... (index ${opts.keyIndex} of ${config.totalKeys})`);
    console.log(`Base URL: ${config.baseUrl}`);
    console.log(`Models to test: ${models.map(m => m.id).join(', ')}`);
    console.log(`Max parallel: ${opts.maxParallel}`);
    console.log(`Rounds per level: ${opts.rounds}`);
    console.log(`Delay between levels: ${opts.delay}ms`);
    if (opts.multiKey) console.log(`Mode: MULTI-KEY (testing per-key vs per-account limits)`);
    if (opts.dryRun) console.log('** DRY RUN MODE **');
    console.log('');

    const allResults = [];
    const multiKeyResults = [];

    for (const model of models) {
        try {
            if (opts.multiKey) {
                const mkResult = await testMultiKeyConcurrency(model, config.allKeys, config.baseUrl, opts);
                multiKeyResults.push(mkResult);
            }

            const result = await testModelConcurrency(model, config, opts);
            allResults.push(result);
        } catch (err) {
            console.error(`Error testing ${model.id}:`, err.message);
            allResults.push({ model: model.id, error: err.message });
        }

        // Longer pause between models
        if (models.indexOf(model) < models.length - 1) {
            console.log(`\n  Waiting ${opts.delay * 2}ms before next model...`);
            await sleep(opts.delay * 2);
        }
    }

    // ── Summary ─────────────────────────────────────────────────────────

    console.log('\n\n');
    console.log('='.repeat(80));
    console.log('CONCURRENCY DISCOVERY RESULTS');
    console.log('='.repeat(80));
    console.log('');

    console.log(padRight('Model', 25) +
        padRight('Metadata', 10) +
        padRight('Max OK', 10) +
        padRight('First 429', 10) +
        padRight('Consistent', 12) +
        'Recommendation');
    console.log('-'.repeat(80));

    for (const r of allResults) {
        if (r.error) {
            console.log(`${padRight(r.model, 25)} ERROR: ${r.error}`);
            continue;
        }

        const maxOk = r.maxObservedConcurrency;
        const first429 = r.firstReject429At || '-';
        const consistent429 = r.consistentReject429At || '-';
        const metaConc = r.maxConcurrencyMetadata;

        // Recommendation
        let rec = '';
        if (maxOk === 0) {
            rec = `set to 1 (was ${metaConc})`;
        } else if (maxOk < metaConc) {
            rec = `REDUCE to ${maxOk} (was ${metaConc})`;
        } else if (maxOk === metaConc) {
            rec = 'correct';
        } else {
            rec = `could INCREASE to ${maxOk} (was ${metaConc})`;
        }

        const flag = maxOk < metaConc ? ' *** ' : '     ';

        console.log(
            padRight(r.model, 25) +
            padRight(String(metaConc), 10) +
            padRight(String(maxOk), 10) +
            padRight(String(first429), 10) +
            padRight(String(consistent429), 12) +
            flag + rec
        );
    }

    console.log('');
    console.log('Legend:');
    console.log('  Metadata     = Current maxConcurrency in model-discovery.js');
    console.log('  Max OK       = Highest concurrency where ALL rounds had 0 429s');
    console.log('  First 429    = First concurrency level with ANY 429');
    console.log('  Consistent   = First concurrency level where ALL rounds had 429s');
    console.log('  ***          = Metadata too high, should reduce');

    // ── Multi-key summary ───────────────────────────────────────────

    if (multiKeyResults.length > 0) {
        console.log('\n');
        console.log('='.repeat(80));
        console.log('PER-KEY vs PER-ACCOUNT ANALYSIS');
        console.log('='.repeat(80));
        console.log('');

        for (const mk of multiKeyResults) {
            const icon = mk.isPerAccount ? '\x1b[33mACCOUNT\x1b[0m' : '\x1b[32mPER-KEY\x1b[0m';
            console.log(`  ${padRight(mk.model, 25)} ${icon}  (single-key max: ${mk.singleKeyMax})`);
        }

        const allPerAccount = multiKeyResults.every(r => r.isPerAccount);
        console.log('');
        if (allPerAccount) {
            console.log('  >> ALL models share account-level concurrency quota.');
            console.log('     Multiple API keys do NOT increase throughput.');
            console.log('     The concurrency multiplier in the router should be set to 1.');
        } else {
            console.log('  >> Some models have per-key limits. Multiple keys help.');
        }
    }

    // ── Save results ────────────────────────────────────────────────────

    const outPath = path.join(__dirname, '..', 'concurrency-test-results.json');
    const output = {
        timestamp: new Date().toISOString(),
        config: {
            keyPrefix: config.apiKey.substring(0, 8),
            baseUrl: config.baseUrl,
            maxParallel: opts.maxParallel,
            rounds: opts.rounds,
            delay: opts.delay,
        },
        results: allResults,
        multiKeyResults: multiKeyResults.length > 0 ? multiKeyResults : undefined,
    };
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`\nResults saved to: ${outPath}`);

    // ── Generate update snippet ─────────────────────────────────────────

    const updates = allResults.filter(r => !r.error && r.maxObservedConcurrency < r.maxConcurrencyMetadata);
    if (updates.length > 0) {
        console.log('\n\nSuggested model-discovery.js updates:');
        console.log('─'.repeat(40));
        for (const u of updates) {
            console.log(`  ${u.model}: maxConcurrency: ${u.maxObservedConcurrency || 1}  (was ${u.maxConcurrencyMetadata})`);
        }
    }
}

// ── Utilities ───────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function padRight(str, len) {
    return String(str).padEnd(len);
}

// ── Run ─────────────────────────────────────────────────────────────────
main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

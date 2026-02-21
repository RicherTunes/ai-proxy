#!/usr/bin/env node
/**
 * Stub Upstream Server
 *
 * Simulates an LLM API backend for testing proxy behavior under various conditions.
 *
 * Scenarios:
 *   - success: Normal 200 response with token usage
 *   - delay: Configurable response delay
 *   - 429: Rate limit responses (with optional burst patterns)
 *   - 500: Server errors
 *   - hangup: Socket hangup mid-response
 *   - timeout: Never responds (for timeout testing)
 *   - streaming: SSE streaming response
 *
 * Usage:
 *   node scripts/stub-upstream.js [--port=3001] [--scenario=success]
 *
 * Environment:
 *   STUB_PORT - Server port (default: 3001)
 *   STUB_SCENARIO - Default scenario (default: success)
 *   STUB_DELAY_MS - Delay for 'delay' scenario (default: 1000)
 *   STUB_429_RATE - Fraction of requests to 429 (0-1, default: 0)
 *   STUB_ERROR_RATE - Fraction of requests to 500 (0-1, default: 0)
 *   STUB_HANGUP_RATE - Fraction of requests to hangup (0-1, default: 0)
 */

const http = require('http');
const { URL } = require('url');

// Configuration
const config = {
    port: parseInt(process.env.STUB_PORT || '3001'),
    scenario: process.env.STUB_SCENARIO || 'success',
    delayMs: parseInt(process.env.STUB_DELAY_MS || '1000'),
    rate429: parseFloat(process.env.STUB_429_RATE || '0'),
    errorRate: parseFloat(process.env.STUB_ERROR_RATE || '0'),
    hangupRate: parseFloat(process.env.STUB_HANGUP_RATE || '0'),
    seed: process.env.STUB_SEED ? parseInt(process.env.STUB_SEED) : null
};

// Seeded PRNG (mulberry32) for deterministic mixed scenarios
function createSeededRandom(seed) {
    let state = seed;
    return function() {
        state |= 0;
        state = state + 0x6D2B79F5 | 0;
        let t = Math.imul(state ^ state >>> 15, 1 | state);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Random function - seeded if seed provided, otherwise Math.random
let random = Math.random;
function initRandom() {
    if (config.seed !== null) {
        random = createSeededRandom(config.seed);
        console.log(`Using seeded RNG with seed: ${config.seed}`);
    }
}

// Parse CLI args
process.argv.slice(2).forEach(arg => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'port') config.port = parseInt(value);
    if (key === 'scenario') config.scenario = value;
    if (key === 'delay') config.delayMs = parseInt(value);
    if (key === 'rate429') config.rate429 = parseFloat(value);
    if (key === 'errorRate') config.errorRate = parseFloat(value);
    if (key === 'hangupRate') config.hangupRate = parseFloat(value);
    if (key === 'seed') config.seed = parseInt(value);
});

// Initialize RNG after CLI args parsed
initRandom();

// Stats tracking
const stats = {
    requests: 0,
    successes: 0,
    errors429: 0,
    errors500: 0,
    hangups: 0,
    timeouts: 0,
    startTime: Date.now()
};

// Response templates
function createSuccessResponse(inputTokens = 100, outputTokens = 50) {
    return {
        id: `stub-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'glm-4-plus',
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: 'This is a stub response for testing.'
            },
            finish_reason: 'stop'
        }],
        usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens
        }
    };
}

function createStreamChunk(content, done = false) {
    const chunk = {
        id: `stub-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'glm-4-plus',
        choices: [{
            index: 0,
            delta: done ? {} : { content },
            finish_reason: done ? 'stop' : null
        }]
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
}

// Scenario handlers
const scenarios = {
    success: async (req, res) => {
        const body = createSuccessResponse();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        stats.successes++;
    },

    delay: async (req, res) => {
        await new Promise(resolve => setTimeout(resolve, config.delayMs));
        const body = createSuccessResponse();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        stats.successes++;
    },

    rate429: async (req, res) => {
        res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '1'
        });
        res.end(JSON.stringify({
            error: {
                message: 'Rate limit exceeded',
                type: 'rate_limit_error',
                code: 'rate_limit_exceeded'
            }
        }));
        stats.errors429++;
    },

    error500: async (req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Internal server error',
                type: 'server_error',
                code: 'internal_error'
            }
        }));
        stats.errors500++;
    },

    hangup: async (req, res) => {
        // Write partial response then destroy socket
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"id":"stub-');
        setTimeout(() => {
            req.socket.destroy();
        }, 50);
        stats.hangups++;
    },

    timeout: async (req, res) => {
        // Never respond - let client timeout
        stats.timeouts++;
        // Keep connection open but don't respond
    },

    streaming: async (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        const words = ['This', ' is', ' a', ' streaming', ' response', ' for', ' testing', '.'];

        for (const word of words) {
            res.write(createStreamChunk(word));
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        res.write(createStreamChunk('', true));
        res.write('data: [DONE]\n\n');
        res.end();
        stats.successes++;
    },

    mixed: async (req, res) => {
        // Probabilistic scenario selection (uses seeded RNG if configured)
        const rand = random();

        if (rand < config.hangupRate) {
            return scenarios.hangup(req, res);
        } else if (rand < config.hangupRate + config.rate429) {
            return scenarios.rate429(req, res);
        } else if (rand < config.hangupRate + config.rate429 + config.errorRate) {
            return scenarios.error500(req, res);
        } else {
            return scenarios.success(req, res);
        }
    }
};

// Request handler
async function handleRequest(req, res) {
    stats.requests++;

    // Parse URL for scenario override
    const url = new URL(req.url, `http://localhost:${config.port}`);
    const scenarioOverride = url.searchParams.get('scenario');
    const scenario = scenarioOverride || config.scenario;

    // Collect request body (for logging/validation)
    let body = '';
    req.on('data', chunk => { body += chunk; });

    req.on('end', async () => {
        // Log request
        if (process.env.STUB_VERBOSE) {
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} scenario=${scenario}`);
        }

        // Handle scenario
        const handler = scenarios[scenario] || scenarios.success;
        try {
            await handler(req, res);
        } catch (err) {
            console.error(`Error handling request: ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end('Internal stub error');
            }
        }
    });
}

// Stats endpoint
function handleStats(req, res) {
    const uptime = (Date.now() - stats.startTime) / 1000;
    const rps = stats.requests / uptime;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ...stats,
        uptime: Math.round(uptime),
        requestsPerSecond: Math.round(rps * 100) / 100,
        config
    }, null, 2));
}

// Health endpoint
function handleHealth(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', scenario: config.scenario }));
}

// Reset stats endpoint
function handleReset(req, res) {
    stats.requests = 0;
    stats.successes = 0;
    stats.errors429 = 0;
    stats.errors500 = 0;
    stats.hangups = 0;
    stats.timeouts = 0;
    stats.startTime = Date.now();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'reset' }));
}

// Config update endpoint
function handleConfig(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const newConfig = JSON.parse(body);
            Object.assign(config, newConfig);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'updated', config }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    });
}

// Main router
function router(req, res) {
    const path = req.url.split('?')[0];

    switch (path) {
        case '/_stub/stats':
            return handleStats(req, res);
        case '/_stub/health':
            return handleHealth(req, res);
        case '/_stub/reset':
            return handleReset(req, res);
        case '/_stub/config':
            return handleConfig(req, res);
        default:
            return handleRequest(req, res);
    }
}

// Create server
const server = http.createServer(router);

server.listen(config.port, () => {
    console.log(`Stub upstream server running on port ${config.port}`);
    console.log(`Default scenario: ${config.scenario}`);
    console.log(`Config: delay=${config.delayMs}ms, 429Rate=${config.rate429}, errorRate=${config.errorRate}, hangupRate=${config.hangupRate}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /v1/chat/completions - LLM endpoint (honors ?scenario= override)`);
    console.log(`  GET  /_stub/stats         - Get request statistics`);
    console.log(`  GET  /_stub/health        - Health check`);
    console.log(`  POST /_stub/reset         - Reset statistics`);
    console.log(`  POST /_stub/config        - Update configuration`);
    console.log(`\nScenarios: success, delay, rate429, error500, hangup, timeout, streaming, mixed`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down stub server...');
    server.close(() => {
        console.log('Stats:', JSON.stringify(stats, null, 2));
        process.exit(0);
    });
});

module.exports = { server, stats, config };

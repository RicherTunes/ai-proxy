/**
 * Stub Server Helper for Integration Tests
 *
 * Provides a local HTTP/HTTPS server for testing proxy behavior.
 * This replaces brittle https.request mocks with real HTTP-level testing.
 *
 * Usage:
 *   const { StubServer } = require('../helpers/stub-server');
 *   const stub = new StubServer();
 *   await stub.start();
 *   // stub.url is the base URL
 *   // stub.setScenario('success') / 'rate429' / 'error500' / etc.
 *   await stub.stop();
 */

const http = require('http');

// Seeded PRNG for deterministic tests
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

class StubServer {
    constructor(options = {}) {
        this.port = options.port || 0; // 0 = random available port
        this.scenario = options.scenario || 'success';
        this.delayMs = options.delayMs || 0;
        this.seed = options.seed || null;
        this.server = null;
        this.url = null;

        // Stats tracking
        this.stats = {
            requests: 0,
            successes: 0,
            errors429: 0,
            errors500: 0,
            errors401: 0,
            hangups: 0,
            timeouts: 0,
            requestBodies: [],
            requestHeaders: []
        };

        // Per-request scenario queue (for deterministic sequences)
        this.scenarioQueue = [];

        // Random function
        this.random = this.seed !== null
            ? createSeededRandom(this.seed)
            : Math.random;
    }

    /**
     * Start the stub server
     * @returns {Promise<string>} Server URL
     */
    async start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this._handleRequest(req, res));

            this.server.on('error', reject);

            this.server.listen(this.port, '127.0.0.1', () => {
                const address = this.server.address();
                this.url = `http://127.0.0.1:${address.port}`;
                resolve(this.url);
            });
        });
    }

    /**
     * Stop the stub server
     */
    async stop() {
        if (!this.server) return;

        return new Promise((resolve) => {
            this.server.close(() => {
                this.server = null;
                this.url = null;
                resolve();
            });
        });
    }

    /**
     * Set the default scenario
     */
    setScenario(scenario) {
        this.scenario = scenario;
    }

    /**
     * Queue specific scenarios for next N requests (deterministic testing)
     * @param {string[]} scenarios - Array of scenario names
     */
    queueScenarios(...scenarios) {
        this.scenarioQueue.push(...scenarios);
    }

    /**
     * Reset stats and scenario queue
     */
    reset() {
        this.stats = {
            requests: 0,
            successes: 0,
            errors429: 0,
            errors500: 0,
            errors401: 0,
            hangups: 0,
            timeouts: 0,
            requestBodies: [],
            requestHeaders: []
        };
        this.scenarioQueue = [];
    }

    /**
     * Get next scenario (from queue or default)
     */
    _getNextScenario() {
        if (this.scenarioQueue.length > 0) {
            return this.scenarioQueue.shift();
        }
        return this.scenario;
    }

    /**
     * Handle incoming request
     */
    _handleRequest(req, res) {
        this.stats.requests++;

        // Collect request body
        let body = '';
        req.on('data', chunk => { body += chunk; });

        req.on('end', async () => {
            // Track request details
            this.stats.requestBodies.push(body);
            this.stats.requestHeaders.push({ ...req.headers });

            // Get scenario for this request
            const scenario = this._getNextScenario();

            // Add configurable delay
            if (this.delayMs > 0) {
                await new Promise(r => setTimeout(r, this.delayMs));
            }

            // Handle scenario
            await this._handleScenario(scenario, req, res, body);
        });
    }

    /**
     * Handle specific scenario
     */
    async _handleScenario(scenario, req, res, body) {
        switch (scenario) {
            case 'success':
                return this._respondSuccess(req, res, body);
            case 'rate429':
                return this._respond429(req, res);
            case 'error500':
                return this._respond500(req, res);
            case 'error401':
                return this._respond401(req, res);
            case 'error403':
                return this._respond403(req, res);
            case 'hangup':
                return this._respondHangup(req, res);
            case 'timeout':
                return this._respondTimeout(req, res);
            case 'streaming':
                return this._respondStreaming(req, res);
            case 'slowSuccess':
                await new Promise(r => setTimeout(r, 2000));
                return this._respondSuccess(req, res, body);
            default:
                return this._respondSuccess(req, res, body);
        }
    }

    /**
     * Success response (200 OK)
     */
    _respondSuccess(req, res, body) {
        this.stats.successes++;

        // Parse body to get model for response
        let requestModel = 'glm-4-plus';
        try {
            const parsed = JSON.parse(body);
            requestModel = parsed.model || requestModel;
        } catch (e) {}

        const response = {
            id: `stub-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: requestModel,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: 'This is a stub response for testing.'
                },
                finish_reason: 'stop'
            }],
            usage: {
                prompt_tokens: 100,
                completion_tokens: 50,
                total_tokens: 150
            }
        };

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'x-request-id': req.headers['x-request-id'] || `stub-${Date.now()}`
        });
        res.end(JSON.stringify(response));
    }

    /**
     * Rate limit response (429)
     */
    _respond429(req, res) {
        this.stats.errors429++;

        res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '1',
            'x-request-id': req.headers['x-request-id'] || `stub-${Date.now()}`
        });
        res.end(JSON.stringify({
            error: {
                message: 'Rate limit exceeded',
                type: 'rate_limit_error',
                code: 'rate_limit_exceeded'
            }
        }));
    }

    /**
     * Server error response (500)
     */
    _respond500(req, res) {
        this.stats.errors500++;

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Internal server error',
                type: 'server_error',
                code: 'internal_error'
            }
        }));
    }

    /**
     * Auth error response (401)
     */
    _respond401(req, res) {
        this.stats.errors401++;

        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Authentication required',
                type: 'authentication_error',
                code: 'invalid_api_key'
            }
        }));
    }

    /**
     * Forbidden response (403)
     */
    _respond403(req, res) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Access forbidden',
                type: 'permission_error',
                code: 'access_denied'
            }
        }));
    }

    /**
     * Socket hangup (partial response then destroy)
     */
    _respondHangup(req, res) {
        this.stats.hangups++;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"id":"stub-');
        setTimeout(() => {
            req.socket.destroy();
        }, 10);
    }

    /**
     * Timeout (never respond)
     */
    _respondTimeout(req, res) {
        this.stats.timeouts++;
        // Never respond - let client timeout
    }

    /**
     * Streaming response (SSE)
     */
    async _respondStreaming(req, res) {
        this.stats.successes++;

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        const words = ['This', ' is', ' streaming'];

        for (const word of words) {
            const chunk = {
                id: `stub-${Date.now()}`,
                object: 'chat.completion.chunk',
                choices: [{
                    index: 0,
                    delta: { content: word },
                    finish_reason: null
                }]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            await new Promise(r => setTimeout(r, 10));
        }

        res.write('data: [DONE]\n\n');
        res.end();
    }
}

module.exports = { StubServer };

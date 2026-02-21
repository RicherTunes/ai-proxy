/**
 * Tier Builder Save Error Handling Tests
 * Tests that 409 (validation) errors preserve local state,
 * while non-recoverable errors (500, 503) trigger server re-fetch.
 */

describe('TierBuilder._doSave error handling', () => {
    // Extract the save error handling logic from tier-builder.js
    // to test the 409 vs non-409 branching without browser environment
    function createSaveHandler() {
        var fetchModelRoutingCalls = 0;
        var lastToastMessage = null;
        var lastToastType = null;

        function fetchModelRouting() { fetchModelRoutingCalls++; }
        function showToast(msg, type) { lastToastMessage = msg; lastToastType = type; }

        // Replica of the save error handling from _doSave
        async function handleSaveResponse(res) {
            if (res.ok) {
                var result = await res.json().catch(function() { return {}; });
                if (result.persisted) {
                    showToast('Tier configuration saved and persisted', 'success');
                } else {
                    showToast('Tier configuration updated (runtime only)', 'warning');
                }
                fetchModelRouting();
            } else {
                var err = await res.json().catch(function() { return {}; });
                showToast('Save failed: ' + (err.error || res.statusText), 'error');
                // On 409 (validation error), keep local state so user can fix the issue.
                // Only re-fetch server state on non-recoverable errors (500, 503, etc.)
                if (res.status !== 409) {
                    fetchModelRouting();
                }
            }
        }

        return {
            handleSaveResponse,
            get fetchModelRoutingCalls() { return fetchModelRoutingCalls; },
            get lastToastMessage() { return lastToastMessage; },
            get lastToastType() { return lastToastType; },
            reset: function() { fetchModelRoutingCalls = 0; lastToastMessage = null; lastToastType = null; }
        };
    }

    function mockResponse(status, body, statusText) {
        return {
            ok: status >= 200 && status < 300,
            status: status,
            statusText: statusText || 'Error',
            json: () => Promise.resolve(body || {})
        };
    }

    test('200 with persisted: calls fetchModelRouting and shows success toast', async () => {
        const handler = createSaveHandler();
        await handler.handleSaveResponse(mockResponse(200, { persisted: true }));

        expect(handler.fetchModelRoutingCalls).toBe(1);
        expect(handler.lastToastType).toBe('success');
        expect(handler.lastToastMessage).toContain('persisted');
    });

    test('200 without persisted: calls fetchModelRouting and shows warning toast', async () => {
        const handler = createSaveHandler();
        await handler.handleSaveResponse(mockResponse(200, { persisted: false }));

        expect(handler.fetchModelRoutingCalls).toBe(1);
        expect(handler.lastToastType).toBe('warning');
        expect(handler.lastToastMessage).toContain('runtime only');
    });

    test('409 Conflict: does NOT call fetchModelRouting (preserves local edits)', async () => {
        const handler = createSaveHandler();
        await handler.handleSaveResponse(mockResponse(409, { error: 'Duplicate model in tier' }, 'Conflict'));

        expect(handler.fetchModelRoutingCalls).toBe(0);
        expect(handler.lastToastType).toBe('error');
        expect(handler.lastToastMessage).toContain('Duplicate model in tier');
    });

    test('500 Internal Error: calls fetchModelRouting (discards local state)', async () => {
        const handler = createSaveHandler();
        await handler.handleSaveResponse(mockResponse(500, { error: 'Internal server error' }, 'Internal Server Error'));

        expect(handler.fetchModelRoutingCalls).toBe(1);
        expect(handler.lastToastType).toBe('error');
    });

    test('503 Service Unavailable: calls fetchModelRouting', async () => {
        const handler = createSaveHandler();
        await handler.handleSaveResponse(mockResponse(503, {}, 'Service Unavailable'));

        expect(handler.fetchModelRoutingCalls).toBe(1);
        expect(handler.lastToastType).toBe('error');
    });

    test('400 Bad Request: calls fetchModelRouting (not a 409)', async () => {
        const handler = createSaveHandler();
        await handler.handleSaveResponse(mockResponse(400, { error: 'Bad request' }, 'Bad Request'));

        expect(handler.fetchModelRoutingCalls).toBe(1);
        expect(handler.lastToastType).toBe('error');
    });

    test('409 with empty error body: uses statusText in toast', async () => {
        const handler = createSaveHandler();
        await handler.handleSaveResponse(mockResponse(409, {}, 'Conflict'));

        expect(handler.fetchModelRoutingCalls).toBe(0);
        expect(handler.lastToastMessage).toContain('Conflict');
    });

    test('error response with JSON parse failure: shows statusText', async () => {
        const handler = createSaveHandler();
        const res = {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: () => Promise.reject(new Error('not json'))
        };
        await handler.handleSaveResponse(res);

        expect(handler.fetchModelRoutingCalls).toBe(1);
        expect(handler.lastToastMessage).toContain('Internal Server Error');
    });

    test('multiple 409s in sequence never trigger re-fetch', async () => {
        const handler = createSaveHandler();

        for (let i = 0; i < 5; i++) {
            await handler.handleSaveResponse(mockResponse(409, { error: 'Validation error ' + i }));
        }

        expect(handler.fetchModelRoutingCalls).toBe(0);
    });
});

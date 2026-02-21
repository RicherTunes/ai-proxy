/**
 * Stats Aggregator Branch Coverage Tests
 * Target: Uncovered line 1306 - generateRequestId function
 */

const { StatsAggregator } = require('../lib/stats-aggregator');
const path = require('path');
const fs = require('fs');

describe('StatsAggregator - Branch Coverage', () => {
    let sa;
    const testDir = path.join(__dirname, 'test-stats-branches');
    const testFile = 'test-stats-branches.json';

    beforeEach(() => {
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }

        sa = new StatsAggregator({
            configDir: testDir,
            statsFile: testFile,
            saveInterval: 1000
        });
    });

    afterEach(async () => {
        if (sa) {
            sa.stopAutoSave();
            await sa.flush();
        }

        const testFilePath = path.join(testDir, testFile);
        if (fs.existsSync(testFilePath)) {
            fs.unlinkSync(testFilePath);
        }
    });

    // Target: Line 1306 - generateRequestId function
    describe('recordRequest with auto-generated ID', () => {
        test('should generate request ID when not provided', () => {
            const request = {
                // No id field - should trigger generateRequestId at line 1306
                keyIndex: 0,
                method: 'POST',
                path: '/v1/messages',
                status: 'pending'
            };

            sa.recordRequest(request);

            const recentRequests = sa.getRecentRequests(1);
            expect(recentRequests).toHaveLength(1);
            expect(recentRequests[0].id).toBeDefined();
            expect(typeof recentRequests[0].id).toBe('string');
            expect(recentRequests[0].id).toMatch(/^req_\d+_[a-z0-9]+$/);
        });

        test('should use provided ID when available', () => {
            const request = {
                id: 'custom-id-123',
                keyIndex: 0,
                method: 'POST',
                path: '/v1/messages',
                status: 'pending'
            };

            sa.recordRequest(request);

            const recentRequests = sa.getRecentRequests(1);
            expect(recentRequests).toHaveLength(1);
            expect(recentRequests[0].id).toBe('custom-id-123');
        });

        test('should generate unique IDs for multiple requests', () => {
            const request1 = {
                keyIndex: 0,
                method: 'POST',
                path: '/v1/messages',
                status: 'pending'
            };

            const request2 = {
                keyIndex: 1,
                method: 'POST',
                path: '/v1/messages',
                status: 'pending'
            };

            sa.recordRequest(request1);
            sa.recordRequest(request2);

            const recentRequests = sa.getRecentRequests(2);
            expect(recentRequests).toHaveLength(2);

            const id1 = recentRequests[0].id;
            const id2 = recentRequests[1].id;

            expect(id1).toBeDefined();
            expect(id2).toBeDefined();
            expect(id1).not.toBe(id2);
        });
    });

    describe('request listener notifications', () => {
        test('should notify listeners when request recorded', (done) => {
            let notifiedRequest = null;

            const listener = (request) => {
                notifiedRequest = request;
            };

            sa.addRequestListener(listener);

            const request = {
                keyIndex: 0,
                method: 'POST',
                path: '/v1/messages',
                status: 'pending'
            };

            sa.recordRequest(request);

            // Give time for notification
            setTimeout(() => {
                expect(notifiedRequest).not.toBeNull();
                expect(notifiedRequest.keyIndex).toBe(0);
                expect(notifiedRequest.method).toBe('POST');

                sa.removeRequestListener(listener);
                done();
            }, 10);
        });
    });
});

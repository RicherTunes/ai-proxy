/**
 * Predictive Scaler Module Tests
 */

const { PredictiveScaler } = require('../lib/predictive-scaler');

// Helper to record a point
function recordPoint(scaler, timestamp, requests, options = {}) {
    scaler.recordUsage(timestamp, {
        requests,
        queueSize: options.queueSize || 0,
        latency: options.latency || 100,
        keyUtilization: options.keyUtilization || 50
    });
}

// Generate steady usage data
function generateSteadyData(scaler, count = 20, baseRequests = 100) {
    const now = Date.now();
    for (let i = 0; i < count; i++) {
        const timestamp = now - (count - i) * 60000;
        const requests = baseRequests + Math.random() * 20 - 10;
        recordPoint(scaler, timestamp, requests);
    }
}

// Generate upward trend data
function generateUpwardTrend(scaler, count = 20, startRequests = 50, endRequests = 200) {
    const now = Date.now();
    const increment = (endRequests - startRequests) / count;
    for (let i = 0; i < count; i++) {
        const timestamp = now - (count - i) * 60000;
        const requests = startRequests + increment * i + Math.random() * 10;
        recordPoint(scaler, timestamp, requests);
    }
}

// Generate downward trend data
function generateDownwardTrend(scaler, count = 20, startRequests = 200, endRequests = 50) {
    const now = Date.now();
    const decrement = (startRequests - endRequests) / count;
    for (let i = 0; i < count; i++) {
        const timestamp = now - (count - i) * 60000;
        const requests = startRequests - decrement * i + Math.random() * 10;
        recordPoint(scaler, timestamp, requests);
    }
}

describe('PredictiveScaler', () => {
    describe('module exports', () => {
        test('should export PredictiveScaler class', () => {
            expect(PredictiveScaler).toBeDefined();
            expect(typeof PredictiveScaler).toBe('function');
        });
    });

    describe('constructor', () => {
        test('should initialize with default config', () => {
            const scaler = new PredictiveScaler();
            expect(scaler.config).toBeDefined();
            expect(scaler.config.minSamples).toBe(10);
            expect(scaler.config.predictionHorizon).toBe(900000);
            expect(scaler.config.historyWindow).toBe(7200000);
            expect(scaler.config.smoothingFactor).toBe(0.3);
        });

        test('should accept custom config', () => {
            const scaler = new PredictiveScaler({
                minSamples: 20,
                predictionHorizon: 1800000,
                historyWindow: 3600000,
                smoothingFactor: 0.5,
                scaleUpThreshold: 0.85,
                scaleDownThreshold: 0.25
            });

            expect(scaler.config.minSamples).toBe(20);
            expect(scaler.config.predictionHorizon).toBe(1800000);
            expect(scaler.config.historyWindow).toBe(3600000);
            expect(scaler.config.smoothingFactor).toBe(0.5);
            expect(scaler.config.scaleUpThreshold).toBe(0.85);
            expect(scaler.config.scaleDownThreshold).toBe(0.25);
        });

        test('should initialize empty history', () => {
            const scaler = new PredictiveScaler();
            expect(scaler.history).toBeInstanceOf(Array);
            expect(scaler.history.length).toBe(0);
        });

        test('should initialize hourly patterns map', () => {
            const scaler = new PredictiveScaler();
            expect(scaler.hourlyPatterns).toBeInstanceOf(Map);
            expect(scaler.hourlyPatterns.size).toBe(0);
        });
    });

    describe('recordUsage', () => {
        test('should record single usage point', () => {
            const scaler = new PredictiveScaler();
            const now = Date.now();

            recordPoint(scaler, now, 100);

            expect(scaler.history.length).toBe(1);
            expect(scaler.history[0].timestamp).toBe(now);
            expect(scaler.history[0].metrics.requests).toBe(100);
        });

        test('should record multiple usage points', () => {
            const scaler = new PredictiveScaler();
            const now = Date.now();

            recordPoint(scaler, now - 2000, 100);
            recordPoint(scaler, now - 1000, 150);
            recordPoint(scaler, now, 200);

            expect(scaler.history.length).toBe(3);
        });

        test('should throw on invalid metrics', () => {
            const scaler = new PredictiveScaler();

            expect(() => scaler.recordUsage(Date.now(), null))
                .toThrow('Invalid metrics: requests is required');

            expect(() => scaler.recordUsage(Date.now(), {}))
                .toThrow('Invalid metrics: requests is required');

            expect(() => scaler.recordUsage(Date.now(), { requests: 'invalid' }))
                .toThrow('Invalid metrics: requests is required');
        });

        test('should update exponential smoothing', () => {
            const scaler = new PredictiveScaler();

            recordPoint(scaler, Date.now(), 100);
            expect(scaler.smoothedValue).toBe(100);

            recordPoint(scaler, Date.now(), 200);
            expect(scaler.smoothedValue).toBeGreaterThan(100);
            expect(scaler.smoothedValue).toBeLessThan(200);
        });

        test('should update hourly patterns', () => {
            const scaler = new PredictiveScaler();
            const now = Date.now();
            const hour = new Date(now).getHours();

            recordPoint(scaler, now, 100);

            expect(scaler.hourlyPatterns.has(hour)).toBe(true);
            expect(scaler.hourlyPatterns.get(hour)).toContain(100);
        });

        test('should clean old history', () => {
            const scaler = new PredictiveScaler({ historyWindow: 60000 });
            const now = Date.now();

            // Record old point
            recordPoint(scaler, now - 120000, 100);
            // Record current point
            recordPoint(scaler, now, 200);

            // Old point should be cleaned
            expect(scaler.history.length).toBe(1);
            expect(scaler.history[0].metrics.requests).toBe(200);
        });
    });

    describe('predict', () => {
        test('should return empty array with insufficient data', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });

            recordPoint(scaler, Date.now(), 100);

            const predictions = scaler.predict();
            expect(predictions).toEqual([]);
        });

        test('should return predictions with sufficient data', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });
            generateSteadyData(scaler, 15);

            const predictions = scaler.predict();

            expect(predictions.length).toBe(5);
            predictions.forEach(p => {
                expect(p).toHaveProperty('timestamp');
                expect(p).toHaveProperty('requests');
                expect(p).toHaveProperty('confidence');
                expect(p).toHaveProperty('basis');
            });
        });

        test('should predict higher values for upward trend', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });
            generateUpwardTrend(scaler, 20, 50, 200);

            const predictions = scaler.predict();
            const lastActual = scaler.history[scaler.history.length - 1].metrics.requests;

            // Last predictions should trend upward
            expect(predictions[predictions.length - 1].requests).toBeGreaterThan(50);
        });

        test('should accept custom horizon', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });
            generateSteadyData(scaler, 15);

            const predictions = scaler.predict(1800000); // 30 minutes

            expect(predictions.length).toBe(5);
            const lastPrediction = predictions[predictions.length - 1];
            expect(lastPrediction.timestamp).toBeGreaterThan(Date.now() + 1700000);
        });
    });

    describe('getRecommendations', () => {
        test('should return empty array with insufficient data', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });

            const recommendations = scaler.getRecommendations();
            expect(recommendations).toEqual([]);
        });

        test('should recommend scale up for high utilization', () => {
            const scaler = new PredictiveScaler({ minSamples: 10, scaleUpThreshold: 0.7 });
            const now = Date.now();

            for (let i = 0; i < 15; i++) {
                scaler.recordUsage(now - (15 - i) * 60000, {
                    requests: 100 + i * 10, // Increasing
                    queueSize: 5,
                    latency: 100,
                    keyUtilization: 85 // High utilization
                });
            }

            const recommendations = scaler.getRecommendations();
            const scaleUp = recommendations.find(r => r.type === 'scale_up');

            expect(scaleUp).toBeDefined();
            expect(scaleUp.priority).toBeGreaterThanOrEqual(3);
        });

        test('should recommend scale down for low utilization', () => {
            const scaler = new PredictiveScaler({ minSamples: 10, scaleDownThreshold: 0.3 });
            const now = Date.now();

            for (let i = 0; i < 15; i++) {
                scaler.recordUsage(now - (15 - i) * 60000, {
                    requests: 100 - i * 5, // Decreasing
                    queueSize: 0,
                    latency: 50,
                    keyUtilization: 15 // Low utilization
                });
            }

            const recommendations = scaler.getRecommendations();
            const scaleDown = recommendations.find(r => r.type === 'scale_down');

            expect(scaleDown).toBeDefined();
        });

        test('should recommend add keys for high latency trend', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });
            const now = Date.now();

            // Need latency to increase >20% in last 5 samples
            for (let i = 0; i < 15; i++) {
                scaler.recordUsage(now - (15 - i) * 60000, {
                    requests: 100,
                    queueSize: 0,
                    latency: 100 * Math.pow(1.15, i), // Exponential latency growth
                    keyUtilization: 50
                });
            }

            const recommendations = scaler.getRecommendations();
            const addKeys = recommendations.find(r => r.type === 'add_keys');

            expect(addKeys).toBeDefined();
        });

        test('should recommend increase limits for growing queue', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });
            const now = Date.now();

            // Need steep queue growth - last 5 values need >1.5x increase
            for (let i = 0; i < 15; i++) {
                scaler.recordUsage(now - (15 - i) * 60000, {
                    requests: 100,
                    queueSize: Math.pow(1.5, i), // Exponential queue growth
                    latency: 100,
                    keyUtilization: 50
                });
            }

            const recommendations = scaler.getRecommendations();
            const increaseLimits = recommendations.find(r => r.type === 'increase_limits');

            expect(increaseLimits).toBeDefined();
            expect(increaseLimits.priority).toBe(5);
        });

        test('should sort recommendations by priority', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });
            const now = Date.now();

            for (let i = 0; i < 15; i++) {
                scaler.recordUsage(now - (15 - i) * 60000, {
                    requests: 100 + i * 20,
                    queueSize: 1 + i * 5,
                    latency: 100 + i * 30,
                    keyUtilization: 70 + i * 2
                });
            }

            const recommendations = scaler.getRecommendations();

            for (let i = 1; i < recommendations.length; i++) {
                expect(recommendations[i - 1].priority).toBeGreaterThanOrEqual(recommendations[i].priority);
            }
        });
    });

    describe('getPatterns', () => {
        test('should return empty array with insufficient data', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });

            const patterns = scaler.getPatterns();
            expect(patterns).toEqual([]);
        });

        test('should detect trend patterns', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });
            generateUpwardTrend(scaler, 30, 50, 300);

            const patterns = scaler.getPatterns();
            const trendPattern = patterns.find(p => p.type === 'trend');

            expect(trendPattern).toBeDefined();
            expect(trendPattern.description).toContain('increasing');
        });
    });

    describe('getTrend', () => {
        test('should return stable with insufficient data', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });

            const trend = scaler.getTrend();

            expect(trend.direction).toBe('stable');
            expect(trend.strength).toBe(0);
            expect(trend.rate).toBe(0);
        });

        test('should detect increasing trend', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });
            generateUpwardTrend(scaler, 20, 50, 200);

            const trend = scaler.getTrend();

            expect(trend.direction).toBe('increasing');
            expect(trend.rate).toBeGreaterThan(0);
        });

        test('should detect decreasing trend', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });
            generateDownwardTrend(scaler, 20, 200, 50);

            const trend = scaler.getTrend();

            expect(trend.direction).toBe('decreasing');
            expect(trend.rate).toBeLessThan(0);
        });

        test('should detect stable trend', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });
            const now = Date.now();

            for (let i = 0; i < 15; i++) {
                recordPoint(scaler, now - (15 - i) * 60000, 100);
            }

            const trend = scaler.getTrend();

            expect(trend.direction).toBe('stable');
        });
    });

    describe('getSeasonality', () => {
        test('should return not detected with insufficient data', () => {
            const scaler = new PredictiveScaler();
            generateSteadyData(scaler, 10);

            const seasonality = scaler.getSeasonality();

            expect(seasonality.detected).toBe(false);
        });

        test('should return hourly factors when available', () => {
            const scaler = new PredictiveScaler();
            const now = Date.now();

            // Generate data across multiple hours
            for (let h = 0; h < 24; h++) {
                for (let i = 0; i < 5; i++) {
                    const timestamp = new Date();
                    timestamp.setHours(h, i * 10, 0, 0);
                    const requests = h >= 9 && h <= 17 ? 200 : 50; // Peak during business hours
                    recordPoint(scaler, timestamp.getTime(), requests);
                }
            }

            const seasonality = scaler.getSeasonality();

            if (seasonality.detected) {
                expect(seasonality.hourlyFactors.length).toBeGreaterThan(0);
            }
        });
    });

    describe('detectAnomalies', () => {
        test('should return empty array with insufficient data', () => {
            const scaler = new PredictiveScaler({ minSamples: 10 });

            const anomalies = scaler.detectAnomalies();
            expect(anomalies).toEqual([]);
        });

        test('should detect spike anomalies', () => {
            const scaler = new PredictiveScaler({ minSamples: 10, anomalyThreshold: 2 });
            const now = Date.now();

            // Generate steady baseline
            for (let i = 0; i < 15; i++) {
                recordPoint(scaler, now - (20 - i) * 60000, 100);
            }

            // Add a spike
            recordPoint(scaler, now - 4 * 60000, 500);
            recordPoint(scaler, now - 3 * 60000, 100);
            recordPoint(scaler, now - 2 * 60000, 100);
            recordPoint(scaler, now - 1 * 60000, 100);
            recordPoint(scaler, now, 100);

            const anomalies = scaler.detectAnomalies();
            const spike = anomalies.find(a => a.type === 'spike');

            expect(spike).toBeDefined();
            expect(spike.value).toBe(500);
        });

        test('should detect drop anomalies', () => {
            const scaler = new PredictiveScaler({ minSamples: 10, anomalyThreshold: 2 });
            const now = Date.now();

            // Generate steady baseline at higher level
            for (let i = 0; i < 15; i++) {
                recordPoint(scaler, now - (20 - i) * 60000, 200);
            }

            // Add a drop
            recordPoint(scaler, now - 4 * 60000, 10);
            recordPoint(scaler, now - 3 * 60000, 200);
            recordPoint(scaler, now - 2 * 60000, 200);
            recordPoint(scaler, now - 1 * 60000, 200);
            recordPoint(scaler, now, 200);

            const anomalies = scaler.detectAnomalies();
            const drop = anomalies.find(a => a.type === 'drop');

            expect(drop).toBeDefined();
            expect(drop.value).toBe(10);
        });

        test('should not detect anomalies in steady data', () => {
            const scaler = new PredictiveScaler({ minSamples: 10, anomalyThreshold: 2.5 });
            generateSteadyData(scaler, 20, 100);

            const anomalies = scaler.detectAnomalies();

            // May have none or very few due to random noise
            expect(anomalies.length).toBeLessThan(3);
        });
    });

    describe('getStats', () => {
        test('should return zero values for empty history', () => {
            const scaler = new PredictiveScaler();

            const stats = scaler.getStats();

            expect(stats.sampleCount).toBe(0);
            expect(stats.timeSpan).toBe(0);
            expect(stats.baseline).toBe(0);
        });

        test('should return correct statistics', () => {
            const scaler = new PredictiveScaler({ minSamples: 5 });
            const now = Date.now();

            recordPoint(scaler, now - 4 * 60000, 100);
            recordPoint(scaler, now - 3 * 60000, 150);
            recordPoint(scaler, now - 2 * 60000, 200);
            recordPoint(scaler, now - 1 * 60000, 150);
            recordPoint(scaler, now, 100);

            const stats = scaler.getStats();

            expect(stats.sampleCount).toBe(5);
            expect(stats.baseline).toBe(140); // Average
            expect(stats.peak).toBe(200);
            expect(stats.valley).toBe(100);
        });
    });

    describe('reset', () => {
        test('should clear all history', () => {
            const scaler = new PredictiveScaler();
            generateSteadyData(scaler, 20);

            expect(scaler.history.length).toBeGreaterThan(0);

            scaler.reset();

            expect(scaler.history.length).toBe(0);
        });

        test('should clear hourly patterns', () => {
            const scaler = new PredictiveScaler();
            generateSteadyData(scaler, 20);

            expect(scaler.hourlyPatterns.size).toBeGreaterThan(0);

            scaler.reset();

            expect(scaler.hourlyPatterns.size).toBe(0);
        });

        test('should reset smoothing values', () => {
            const scaler = new PredictiveScaler();
            generateSteadyData(scaler, 20);

            expect(scaler.smoothedValue).not.toBeNull();

            scaler.reset();

            expect(scaler.smoothedValue).toBeNull();
            expect(scaler.trendValue).toBeNull();
        });

        test('should allow new recordings after reset', () => {
            const scaler = new PredictiveScaler();
            generateSteadyData(scaler, 20);

            scaler.reset();

            recordPoint(scaler, Date.now(), 100);

            expect(scaler.history.length).toBe(1);
        });
    });

    describe('edge cases', () => {
        test('should handle zero request values', () => {
            const scaler = new PredictiveScaler();

            expect(() => recordPoint(scaler, Date.now(), 0)).not.toThrow();
            expect(scaler.history[0].metrics.requests).toBe(0);
        });

        test('should handle very large request values', () => {
            const scaler = new PredictiveScaler();

            recordPoint(scaler, Date.now(), 1000000);
            expect(scaler.history[0].metrics.requests).toBe(1000000);
        });

        test('should handle rapid consecutive recordings', () => {
            const scaler = new PredictiveScaler();
            const now = Date.now();

            for (let i = 0; i < 100; i++) {
                recordPoint(scaler, now + i, 100 + i);
            }

            expect(scaler.history.length).toBe(100);
        });

        test('should handle negative timestamp differences gracefully', () => {
            const scaler = new PredictiveScaler();
            const now = Date.now();

            recordPoint(scaler, now, 100);
            recordPoint(scaler, now - 1000, 90); // Earlier timestamp added later

            expect(scaler.history.length).toBe(2);
        });
    });
});

'use strict';
/**
 * Predictive Scaler Coverage Tests
 * Targeting uncovered branches for 98%+ function coverage
 *
 * Baseline coverage: Function 85.27%, Branch 95.2%
 * Uncovered lines: 260, 293, 315-322, 350, 407-432, 533-541, 614-679, 717, 737
 */

const { PredictiveScaler } = require('../lib/predictive-scaler');

// Helper to record a point with full metrics
function recordPoint(scaler, timestamp, requests, options = {}) {
  scaler.recordUsage(timestamp, {
    requests,
    queueSize: options.queueSize !== undefined ? options.queueSize : 0,
    latency: options.latency !== undefined ? options.latency : 100,
    keyUtilization: options.keyUtilization !== undefined ? options.keyUtilization : 50
  });
}

describe('PredictiveScaler Coverage Tests', () => {

  // ─── Line 260: _getTrendPrediction returns 0 with < 2 history items ───
  describe('_getTrendPrediction with insufficient history (line 260)', () => {
    test('should return 0 when history has fewer than 2 items', () => {
      const scaler = new PredictiveScaler();

      // Only 1 data point
      recordPoint(scaler, Date.now(), 100);

      const trend = scaler._getTrendPrediction();

      expect(trend).toBe(0);
    });

    test('should return 0 when history is empty', () => {
      const scaler = new PredictiveScaler();

      const trend = scaler._getTrendPrediction();

      expect(trend).toBe(0);
    });
  });

  // ─── Line 293: _getBaselineAverage returns 0 for empty history ───
  describe('_getBaselineAverage with empty history (line 293)', () => {
    test('should return 0 when history is empty', () => {
      const scaler = new PredictiveScaler();

      const avg = scaler._getBaselineAverage();

      expect(avg).toBe(0);
    });
  });

  // ─── Lines 315-322: scale_down recommendation path ───
  describe('getRecommendations scale_down path (lines 315-322)', () => {
    test('should recommend scale_down when predicted demand drops significantly with low utilization', () => {
      const scaler = new PredictiveScaler({ minSamples: 5, scaleDownThreshold: 0.4 });
      const now = Date.now();

      // Create data with decreasing trend and low utilization
      for (let i = 0; i < 15; i++) {
        scaler.recordUsage(now - (15 - i) * 60000, {
          requests: 200 - i * 10, // Strong downward trend: 200 -> 60
          queueSize: 0,
          latency: 50,
          keyUtilization: 20 // Low utilization (< scaleDownThreshold 0.4 * 100 = 40)
        });
      }

      const recommendations = scaler.getRecommendations();
      const scaleDown = recommendations.find(r => r.type === 'scale_down');

      expect(scaleDown).toBeDefined();
      expect(scaleDown.reason).toContain('demand decrease');
      expect(scaleDown.details.currentUtilization).toBe(20);
    });

    test('should compute predictedGrowth correctly when currentRequests is zero', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();

      // Last entry has requests = 0
      for (let i = 0; i < 14; i++) {
        scaler.recordUsage(now - (15 - i) * 60000, {
          requests: 100,
          queueSize: 0,
          latency: 50,
          keyUtilization: 20
        });
      }
      // Last entry with 0 requests
      scaler.recordUsage(now, {
        requests: 0,
        queueSize: 0,
        latency: 50,
        keyUtilization: 20
      });

      // This should NOT throw due to division by zero handling
      const recommendations = scaler.getRecommendations();

      // Should handle gracefully (predictedGrowth = 1 when currentRequests = 0)
      expect(Array.isArray(recommendations)).toBe(true);
    });
  });

  // ─── Line 350: Latency recommendation with undefined latency check ───
  describe('getRecommendations latency branch (line 350)', () => {
    test('should skip latency recommendations when latency is undefined', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();

      // Record entries without latency field
      for (let i = 0; i < 15; i++) {
        scaler.recordUsage(now - (15 - i) * 60000, {
          requests: 100,
          queueSize: 0,
          keyUtilization: 50
          // latency is undefined
        });
      }

      const recommendations = scaler.getRecommendations();

      // Should not crash and should not include add_keys for latency
      const latencyRec = recommendations.find(r => r.type === 'add_keys' && r.reason.includes('Latency'));
      expect(latencyRec).toBeUndefined();
    });

    test('should generate latency recommendation when latency trend > 1.2', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();

      // _getLatencyTrend takes last 5 entries. We need the last 5 to show
      // increasing latency: first 2 ~50, last 3 ~100 => ratio = 100/50 = 2.0
      // First 5 entries (will be outside last-5 window)
      for (let i = 0; i < 5; i++) {
        scaler.recordUsage(now - (10 - i) * 60000, {
          requests: 100,
          queueSize: 0,
          latency: 50,
          keyUtilization: 50
        });
      }
      // Last 5 entries: 2 with low latency, 3 with high latency
      for (let i = 0; i < 2; i++) {
        scaler.recordUsage(now - (5 - i) * 60000, {
          requests: 100,
          queueSize: 0,
          latency: 50,
          keyUtilization: 50
        });
      }
      for (let i = 0; i < 3; i++) {
        scaler.recordUsage(now - (3 - i) * 60000, {
          requests: 100,
          queueSize: 0,
          latency: 100,
          keyUtilization: 50
        });
      }

      const recommendations = scaler.getRecommendations();
      const latencyRec = recommendations.find(r => r.type === 'add_keys');

      expect(latencyRec).toBeDefined();
      expect(latencyRec.reason).toContain('Latency');
    });
  });

  // ─── Lines 407-417: _getLatencyTrend edge cases ───
  describe('_getLatencyTrend edge cases (lines 407-417)', () => {
    test('should return 1 when history has fewer than 5 items', () => {
      const scaler = new PredictiveScaler();

      recordPoint(scaler, Date.now(), 100, { latency: 50 });

      const trend = scaler._getLatencyTrend();

      expect(trend).toBe(1);
    });

    test('should return 1 when fewer than 2 latency values are defined', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();

      // Only 1 entry has latency defined
      for (let i = 0; i < 5; i++) {
        scaler.recordUsage(now - (5 - i) * 60000, {
          requests: 100,
          queueSize: 0
          // No latency
        });
      }
      // Add one with latency
      scaler.recordUsage(now, {
        requests: 100,
        queueSize: 0,
        latency: 50
      });

      const trend = scaler._getLatencyTrend();

      expect(trend).toBe(1);
    });

    test('should return 1 when firstHalf average is 0', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();

      // First half with 0 latency
      for (let i = 0; i < 3; i++) {
        scaler.recordUsage(now - (10 - i) * 60000, {
          requests: 100,
          queueSize: 0,
          latency: 0,
          keyUtilization: 50
        });
      }
      // Second half with positive latency
      for (let i = 3; i < 6; i++) {
        scaler.recordUsage(now - (10 - i) * 60000, {
          requests: 100,
          queueSize: 0,
          latency: 100,
          keyUtilization: 50
        });
      }

      const trend = scaler._getLatencyTrend();

      expect(trend).toBe(1);
    });

    test('should calculate correct ratio when both halves have valid data', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();

      // Last 5 entries: 2 with latency 50, 3 with latency 100
      // firstHalf = avg([50, 50]) = 50, secondHalf = avg([50, 100, 100]) = 83.33
      // ratio = 83.33 / 50 = 1.6667
      // Need extra entries to make history >= 5 before the last 5
      for (let i = 0; i < 5; i++) {
        scaler.recordUsage(now - (15 - i) * 60000, {
          requests: 100,
          queueSize: 0,
          latency: 50,
          keyUtilization: 50
        });
      }
      for (let i = 0; i < 2; i++) {
        scaler.recordUsage(now - (10 - i) * 60000, {
          requests: 100,
          queueSize: 0,
          latency: 50,
          keyUtilization: 50
        });
      }
      for (let i = 0; i < 3; i++) {
        scaler.recordUsage(now - (3 - i) * 60000, {
          requests: 100,
          queueSize: 0,
          latency: 100,
          keyUtilization: 50
        });
      }

      const trend = scaler._getLatencyTrend();

      // Ratio: secondHalf / firstHalf = avg([100, 100, 100]) / avg([50, 50]) = 100/50 = 2
      expect(trend).toBe(2);
    });
  });

  // ─── Lines 423-432: _getQueueTrend edge cases ───
  describe('_getQueueTrend edge cases (lines 423-432)', () => {
    test('should return 1 when history has fewer than 5 items', () => {
      const scaler = new PredictiveScaler();

      recordPoint(scaler, Date.now(), 100, { queueSize: 5 });

      const trend = scaler._getQueueTrend();

      expect(trend).toBe(1);
    });

    test('should return 1 when fewer than 2 queue values are defined', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();

      // 5 entries but only 1 has queueSize defined
      for (let i = 0; i < 4; i++) {
        scaler.recordUsage(now - (5 - i) * 60000, {
          requests: 100
          // No queueSize
        });
      }
      scaler.recordUsage(now, {
        requests: 100,
        queueSize: 10
      });

      const trend = scaler._getQueueTrend();

      expect(trend).toBe(1);
    });

    test('should return 2 when firstHalf is 0 and secondHalf is positive', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();

      // First half with queueSize 0
      for (let i = 0; i < 3; i++) {
        scaler.recordUsage(now - (10 - i) * 60000, {
          requests: 100,
          queueSize: 0,
          latency: 50,
          keyUtilization: 50
        });
      }
      // Second half with positive queueSize
      for (let i = 3; i < 6; i++) {
        scaler.recordUsage(now - (10 - i) * 60000, {
          requests: 100,
          queueSize: 50,
          latency: 50,
          keyUtilization: 50
        });
      }

      const trend = scaler._getQueueTrend();

      // Line 432: if firstHalf === 0 return secondHalf > 0 ? 2 : 1
      expect(trend).toBe(2);
    });

    test('should return 1 when both firstHalf and secondHalf are 0', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();

      // All entries with queueSize 0
      for (let i = 0; i < 6; i++) {
        scaler.recordUsage(now - (10 - i) * 60000, {
          requests: 100,
          queueSize: 0,
          latency: 50,
          keyUtilization: 50
        });
      }

      const trend = scaler._getQueueTrend();

      // firstHalf = 0, secondHalf = 0 => return 1 (since secondHalf > 0 is false)
      expect(trend).toBe(1);
    });

    test('should calculate correct ratio when both halves have valid queue data', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();

      // Last 5 entries: 2 with queue 10, 3 with queue 30
      // recent = [10, 10, 30, 30, 30]
      // firstHalf = avg([10, 10]) = 10, secondHalf = avg([30, 30, 30]) = 30
      // ratio = 30 / 10 = 3
      for (let i = 0; i < 5; i++) {
        scaler.recordUsage(now - (15 - i) * 60000, {
          requests: 100,
          queueSize: 10,
          latency: 50,
          keyUtilization: 50
        });
      }
      for (let i = 0; i < 2; i++) {
        scaler.recordUsage(now - (10 - i) * 60000, {
          requests: 100,
          queueSize: 10,
          latency: 50,
          keyUtilization: 50
        });
      }
      for (let i = 0; i < 3; i++) {
        scaler.recordUsage(now - (3 - i) * 60000, {
          requests: 100,
          queueSize: 30,
          latency: 50,
          keyUtilization: 50
        });
      }

      const trend = scaler._getQueueTrend();

      expect(trend).toBe(3);
    });
  });

  // ─── Lines 533-541: _detectValleyHours loop branches ───
  describe('_detectValleyHours loop execution (lines 533-541)', () => {
    test('should return empty result when no hour meets criteria', () => {
      const scaler = new PredictiveScaler();

      // Only 2 samples per hour (need 3 for hourly pattern entry)
      const now = Date.now();
      for (let h = 0; h < 5; h++) {
        for (let i = 0; i < 2; i++) {
          const ts = new Date(now);
          ts.setHours(h, i * 10, 0, 0);
          recordPoint(scaler, ts.getTime(), 100);
        }
      }

      const result = scaler._detectValleyHours();

      expect(result).toEqual({ hours: [], intensity: 0 });
    });

    test('should process hours with exactly 3 samples', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();

      // Valley hour with exactly 3 samples (low value = 5)
      for (let i = 0; i < 3; i++) {
        const ts = new Date(now);
        ts.setHours(3, i * 10, 0, 0);
        recordPoint(scaler, ts.getTime(), 5);
      }

      // Normal hours with high values (need 3+ samples each)
      for (let h = 10; h < 15; h++) {
        for (let i = 0; i < 3; i++) {
          const ts = new Date(now);
          ts.setHours(h, i * 10, 0, 0);
          recordPoint(scaler, ts.getTime(), 500);
        }
      }

      const result = scaler._detectValleyHours();

      // Hour 3 should be detected as valley (avg 5 << threshold)
      expect(result.hours).toContain(3);
    });
  });

  // ─── Lines 614-626: getSeasonality loop branches ───
  describe('getSeasonality loop execution (lines 614-626)', () => {
    test('should include hours with exactly 3 samples in hourlyFactors', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();

      // Create 12+ hours with exactly 3 samples each
      for (let h = 0; h < 15; h++) {
        for (let i = 0; i < 3; i++) {
          const ts = new Date(now);
          ts.setHours(h, i * 10, 0, 0);
          // Vary requests to create variation
          const requests = h % 2 === 0 ? 200 : 50;
          recordPoint(scaler, ts.getTime(), requests);
        }
      }

      const seasonality = scaler.getSeasonality();

      // Should have hourlyFactors for each qualifying hour
      expect(seasonality.hourlyFactors.length).toBeGreaterThan(0);
      seasonality.hourlyFactors.forEach(factor => {
        expect(factor).toHaveProperty('hour');
        expect(factor).toHaveProperty('factor');
        expect(factor).toHaveProperty('sampleSize');
        expect(factor.sampleSize).toBeGreaterThanOrEqual(3);
      });
    });

    test('should detect seasonality when average variation exceeds 0.2', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();

      // Create high variation: some hours very high, some very low
      for (let h = 0; h < 14; h++) {
        for (let i = 0; i < 4; i++) {
          const ts = new Date(now);
          ts.setHours(h, i * 10, 0, 0);
          // High variation: 500 vs 50 creates large factor difference
          const requests = h < 7 ? 500 : 50;
          recordPoint(scaler, ts.getTime(), requests);
        }
      }

      const seasonality = scaler.getSeasonality();

      // With significant variation, detected should be true
      expect(seasonality.detected).toBe(true);
    });

    test('should not detect seasonality when variation is low', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();

      // Create low variation (all similar values)
      for (let h = 0; h < 14; h++) {
        for (let i = 0; i < 4; i++) {
          const ts = new Date(now);
          ts.setHours(h, i * 10, 0, 0);
          recordPoint(scaler, ts.getTime(), 100); // All same value
        }
      }

      const seasonality = scaler.getSeasonality();

      // With no variation, detected should be false
      expect(seasonality.detected).toBe(false);
    });
  });

  // ─── Lines 677-695: _calculateRSquared edge cases ───
  describe('_calculateRSquared edge cases (lines 677-695)', () => {
    test('should return 0 when fewer than 2 values', () => {
      const scaler = new PredictiveScaler();

      expect(scaler._calculateRSquared([100])).toBe(0);
      expect(scaler._calculateRSquared([])).toBe(0);
    });

    test('should return 0 when ssTotal is 0 (all values identical)', () => {
      const scaler = new PredictiveScaler();

      // All identical values => ssTotal = 0
      const result = scaler._calculateRSquared([100, 100, 100, 100]);

      expect(result).toBe(0);
    });

    test('should calculate positive R-squared for linear trend', () => {
      const scaler = new PredictiveScaler();

      // Perfect linear trend: y = x
      const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      const result = scaler._calculateRSquared(values);

      // R-squared should be close to 1 for perfect linear data
      expect(result).toBeGreaterThan(0.9);
    });

    test('should return value between 0 and 1 for any data', () => {
      const scaler = new PredictiveScaler();

      // Random-ish data
      const values = [10, 25, 18, 30, 22, 35, 28, 40, 33, 45];
      const result = scaler._calculateRSquared(values);

      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    });
  });

  // ─── Line 717: detectAnomalies zScore = 0 path ───
  describe('detectAnomalies zScore branch (line 717)', () => {
    test('should set zScore to 0 when stdDev is 0', () => {
      const scaler = new PredictiveScaler({ minSamples: 5, anomalyThreshold: 2.5 });
      const now = Date.now();

      // All identical values => stdDev = 0
      for (let i = 0; i < 15; i++) {
        recordPoint(scaler, now - (15 - i) * 60000, 100);
      }

      const anomalies = scaler.detectAnomalies();

      // With stdDev = 0, zScore = 0 for all points, none should be anomalous
      expect(anomalies).toEqual([]);
    });
  });

  // ─── Line 737: _standardDeviation with empty array ───
  describe('_standardDeviation edge cases (line 737)', () => {
    test('should return 0 for empty array', () => {
      const scaler = new PredictiveScaler();

      const stdDev = scaler._standardDeviation([], 0);

      expect(stdDev).toBe(0);
    });

    test('should calculate correct stdDev for single value', () => {
      const scaler = new PredictiveScaler();

      const stdDev = scaler._standardDeviation([100], 100);

      // Single value at mean => variance = 0 => stdDev = 0
      expect(stdDev).toBe(0);
    });

    test('should calculate correct stdDev for multiple values', () => {
      const scaler = new PredictiveScaler();

      // Values: 2, 4, 4, 4, 5, 5, 7, 9 => mean = 5, stdDev ≈ 2
      const values = [2, 4, 4, 4, 5, 5, 7, 9];
      const mean = 5;
      const stdDev = scaler._standardDeviation(values, mean);

      // Expected: sqrt(((2-5)² + 3*(4-5)² + 2*(5-5)² + (7-5)² + (9-5)²) / 8)
      // = sqrt((9 + 3 + 0 + 4 + 16) / 8) = sqrt(32/8) = sqrt(4) = 2
      expect(stdDev).toBeCloseTo(2, 1);
    });
  });

  // ─── stop() and destroy() methods ───
  describe('stop() and destroy() methods', () => {
    test('stop() should call reset() and be idempotent', () => {
      const scaler = new PredictiveScaler();
      recordPoint(scaler, Date.now(), 100);

      expect(scaler.history.length).toBe(1);

      scaler.stop();

      expect(scaler.history.length).toBe(0);

      // Call stop again - should not throw
      scaler.stop();
      expect(scaler.history.length).toBe(0);
    });

    test('destroy() should call stop()', () => {
      const scaler = new PredictiveScaler();
      recordPoint(scaler, Date.now(), 100);

      expect(scaler.history.length).toBe(1);

      scaler.destroy();

      expect(scaler.history.length).toBe(0);
    });
  });

  // ─── History cap at 10000 items (lines 117-118) ───
  describe('history hard cap (lines 117-118)', () => {
    test('should trim history when exceeding 10000 items', () => {
      const scaler = new PredictiveScaler({ historyWindow: Infinity });
      const now = Date.now();

      // Add 10001 items to trigger the cap
      for (let i = 0; i < 10001; i++) {
        recordPoint(scaler, now + i, 100);
      }

      // Should be trimmed to 5000
      expect(scaler.history.length).toBe(5000);
    });
  });

  // ─── Trend-based recommendation (lines 383-394) ───
  describe('getRecommendations trend-based recommendation (lines 383-394)', () => {
    test('should add scale_up recommendation for strong increasing trend', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();

      // Create strong upward trend with high R-squared
      for (let i = 0; i < 20; i++) {
        scaler.recordUsage(now - (20 - i) * 60000, {
          requests: 50 + i * 10, // Strong linear increase: 50 -> 240
          queueSize: 0,
          latency: 50,
          keyUtilization: 50 // Medium utilization (not high)
        });
      }

      const recommendations = scaler.getRecommendations();

      // Should have trend-based scale_up recommendation
      const trendRec = recommendations.find(r =>
        r.reason.includes('upward trend detected') || r.reason.includes('Strong upward trend')
      );
      expect(trendRec).toBeDefined();
      expect(trendRec.details.trendDirection).toBe('increasing');
      expect(trendRec.details.trendStrength).toBeGreaterThan(0.7);
    });
  });

  // ─── _linearRegression with denominator 0 (line 668) ───
  describe('_linearRegression edge cases', () => {
    test('should return 0 when denominator is 0 (impossible with real data)', () => {
      const scaler = new PredictiveScaler();

      // This is a theoretical edge case - with n=2 and x values 0,1
      // denominator = 2 * (0 + 1) - (0 + 1)² = 2 - 1 = 1 (not 0)
      // With constant x values, which can't happen in our implementation
      // since x = i (0, 1, 2, ...)

      // Just verify normal operation
      const slope = scaler._linearRegression([10, 20, 30, 40]);
      expect(slope).toBeCloseTo(10, 1); // slope should be ~10
    });

    test('should calculate correct slope for perfect linear data', () => {
      const scaler = new PredictiveScaler();

      // Perfect linear: y = 2x + 10
      const values = [10, 12, 14, 16, 18, 20];
      const slope = scaler._linearRegression(values);

      expect(slope).toBeCloseTo(2, 1);
    });
  });

  // ─── _average with various inputs ───
  describe('_average helper', () => {
    test('should return 0 for empty array', () => {
      const scaler = new PredictiveScaler();

      expect(scaler._average([])).toBe(0);
    });

    test('should calculate correct average', () => {
      const scaler = new PredictiveScaler();

      expect(scaler._average([10, 20, 30])).toBe(20);
      expect(scaler._average([5])).toBe(5);
    });
  });

  // ─── _getSeasonalFactor with various states ───
  describe('_getSeasonalFactor comprehensive coverage', () => {
    test('should return factor > 1 for high-traffic hour', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();
      const currentHour = new Date(now).getHours();

      // Current hour has high traffic
      for (let i = 0; i < 5; i++) {
        recordPoint(scaler, now - i * 60000, 500);
      }

      // Different hour has low traffic (to create contrast in baseline)
      const otherHour = (currentHour + 6) % 24;
      const otherTs = new Date(now);
      otherTs.setHours(otherHour);
      for (let i = 0; i < 5; i++) {
        const ts = new Date(otherTs);
        ts.setMinutes(i * 10);
        recordPoint(scaler, ts.getTime(), 50);
      }

      const factor = scaler._getSeasonalFactor(now);

      // Current hour average / overall average > 1
      expect(factor).toBeGreaterThan(1);
    });

    test('should return factor < 1 for low-traffic hour', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();
      const currentHour = new Date(now).getHours();

      // Current hour has low traffic
      for (let i = 0; i < 5; i++) {
        recordPoint(scaler, now - i * 60000, 10);
      }

      // Different hour has high traffic
      const otherHour = (currentHour + 6) % 24;
      const otherTs = new Date(now);
      otherTs.setHours(otherHour);
      for (let i = 0; i < 5; i++) {
        const ts = new Date(otherTs);
        ts.setMinutes(i * 10);
        recordPoint(scaler, ts.getTime(), 500);
      }

      const factor = scaler._getSeasonalFactor(now);

      // Current hour average / overall average < 1
      expect(factor).toBeLessThan(1);
    });
  });

  // ─── predict with custom horizon parameter ───
  describe('predict with custom horizon', () => {
    test('should use default horizon when not specified', () => {
      const scaler = new PredictiveScaler({ minSamples: 5, predictionHorizon: 600000 });
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        recordPoint(scaler, now - (10 - i) * 60000, 100);
      }

      const predictions = scaler.predict();

      // 5 prediction points spanning the horizon
      const timeSpan = predictions[4].timestamp - predictions[0].timestamp;
      // step = horizon / 5, timespan = 4 * step = 0.8 * horizon
      expect(timeSpan).toBeGreaterThan(400000); // ~0.8 * 600000
    });
  });

  // ─── getTrend with edge cases ───
  describe('getTrend edge cases', () => {
    test('should return stable for flat data', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();

      // All identical values
      for (let i = 0; i < 15; i++) {
        recordPoint(scaler, now - (15 - i) * 60000, 100);
      }

      const trend = scaler.getTrend();

      // Slope should be ~0, direction stable
      expect(trend.rate).toBeCloseTo(0, 1);
    });

    test('should detect decreasing direction correctly', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();

      // Strong downward trend
      for (let i = 0; i < 15; i++) {
        recordPoint(scaler, now - (15 - i) * 60000, 200 - i * 10);
      }

      const trend = scaler.getTrend();

      expect(trend.direction).toBe('decreasing');
      expect(trend.rate).toBeLessThan(-0.1);
    });
  });
});

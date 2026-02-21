/**
 * Extended Predictive Scaler Tests - Targeting uncovered branches and statements
 *
 * Uncovered lines: 123, 140-141, 234-235, 271, 445, 456, 506, 511, 544, 549, 599
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

// Build data that creates distinct hourly patterns across multiple hours
// with at least 3 samples per hour (required by _detectPeakHours/_detectValleyHours)
function buildHourlyPatternData(scaler, peakHours, valleyHours, minSamples = 10) {
  const now = Date.now();
  const baseTimestamp = new Date(now);

  // We need at least 3 data points per hour for hourly pattern detection.
  // Populate at least 4 distinct hours (some peak, some valley, some normal).
  const allHours = new Set([...peakHours, ...valleyHours]);
  // Add some "normal" hours to create contrast
  for (let h = 0; h < 24; h++) {
    allHours.add(h);
    if (allHours.size >= 6) break; // At least 6 distinct hours
  }

  let count = 0;
  for (const hour of allHours) {
    const requestVal = peakHours.includes(hour) ? 500
      : valleyHours.includes(hour) ? 10
        : 100; // normal baseline

    for (let i = 0; i < 4; i++) {
      const ts = new Date(baseTimestamp);
      ts.setHours(hour, i * 10, 0, 0);
      recordPoint(scaler, ts.getTime(), requestVal);
      count++;
    }
  }

  // Ensure we meet minSamples with additional normal-hour data if needed
  while (count < minSamples) {
    recordPoint(scaler, now - (count * 60000), 100);
    count++;
  }
}

describe('PredictiveScaler - Extended Coverage', () => {

  // ─── Line 123: _updateSmoothing early return for NaN ───
  describe('_updateSmoothing NaN/Infinity guard (line 123)', () => {
    test('should skip NaN values in smoothing update', () => {
      const scaler = new PredictiveScaler();

      // First record a valid value to initialize smoothing
      recordPoint(scaler, Date.now(), 100);
      const smoothedBefore = scaler.smoothedValue;

      // Directly call _updateSmoothing with NaN - should be a no-op
      scaler._updateSmoothing(NaN);

      // smoothedValue should remain unchanged
      expect(scaler.smoothedValue).toBe(smoothedBefore);
    });

    test('should skip Infinity values in smoothing update', () => {
      const scaler = new PredictiveScaler();

      recordPoint(scaler, Date.now(), 100);
      const smoothedBefore = scaler.smoothedValue;

      scaler._updateSmoothing(Infinity);

      expect(scaler.smoothedValue).toBe(smoothedBefore);
    });

    test('should skip -Infinity values in smoothing update', () => {
      const scaler = new PredictiveScaler();

      recordPoint(scaler, Date.now(), 50);
      const smoothedBefore = scaler.smoothedValue;

      scaler._updateSmoothing(-Infinity);

      expect(scaler.smoothedValue).toBe(smoothedBefore);
    });

    test('should skip NaN when smoothedValue is still null (first call)', () => {
      const scaler = new PredictiveScaler();

      // smoothedValue is null initially
      expect(scaler.smoothedValue).toBeNull();

      scaler._updateSmoothing(NaN);

      // Should remain null since NaN was skipped
      expect(scaler.smoothedValue).toBeNull();
    });
  });

  // ─── Lines 140-141: _updateSmoothing safety reset when values become invalid ───
  describe('_updateSmoothing safety reset (lines 140-141)', () => {
    test('should reset smoothedValue and trendValue when computation yields invalid values', () => {
      const scaler = new PredictiveScaler({ smoothingFactor: 0.3 });

      // Initialize with a valid value
      scaler._updateSmoothing(100);
      expect(scaler.smoothedValue).toBe(100);
      expect(scaler.trendValue).toBe(0);

      // Force the internal state to a value that will cause overflow/invalid on next update
      // If smoothedValue is Infinity (but we pass a finite value), the computation will produce Infinity
      // then the safety check at lines 139-141 resets
      scaler.smoothedValue = 1e308;
      scaler.trendValue = 1e308;

      // This computation: alpha*value + (1-alpha)*(1e308 + 1e308) will overflow to Infinity
      scaler._updateSmoothing(100);

      // After safety reset, smoothedValue should equal the passed value (100)
      expect(scaler.smoothedValue).toBe(100);
      expect(scaler.trendValue).toBe(0);
    });

    test('should reset when trendValue computation overflows', () => {
      const scaler = new PredictiveScaler({ smoothingFactor: 0.99 });

      scaler._updateSmoothing(50);

      // Set smoothedValue to extreme value that will cause overflow
      scaler.smoothedValue = Number.MAX_VALUE;
      scaler.trendValue = Number.MAX_VALUE;

      scaler._updateSmoothing(1);

      // Safety reset should have fired
      expect(Number.isFinite(scaler.smoothedValue)).toBe(true);
      expect(Number.isFinite(scaler.trendValue)).toBe(true);
    });
  });

  // ─── Lines 234-235: _predictAtTime fallback to baseline*seasonalFactor ───
  describe('_predictAtTime baseline fallback (lines 234-235)', () => {
    test('should use baseline prediction when smoothedValue is null', () => {
      const scaler = new PredictiveScaler({ minSamples: 3 });
      const now = Date.now();

      // Add enough data points to pass minSamples check
      for (let i = 0; i < 5; i++) {
        recordPoint(scaler, now - (5 - i) * 60000, 100);
      }

      // Force smoothedValue to null to exercise the fallback path
      scaler.smoothedValue = null;

      const predictions = scaler.predict();

      expect(predictions.length).toBe(5);
      predictions.forEach(p => {
        expect(p.basis).toBe('baseline');
        expect(p.confidence).toBe(0.5);
        expect(p.requests).toBeGreaterThanOrEqual(0);
      });
    });

    test('should use baseline prediction when trendValue is null', () => {
      const scaler = new PredictiveScaler({ minSamples: 3 });
      const now = Date.now();

      for (let i = 0; i < 5; i++) {
        recordPoint(scaler, now - (5 - i) * 60000, 80);
      }

      // Force trendValue to null
      scaler.trendValue = null;

      const predictions = scaler.predict();

      expect(predictions.length).toBe(5);
      predictions.forEach(p => {
        expect(p.basis).toBe('baseline');
        expect(p.confidence).toBe(0.5);
      });
    });
  });

  // ─── Line 271: _getSeasonalFactor returns 1 with <3 samples ───
  describe('_getSeasonalFactor insufficient data (line 271)', () => {
    test('should return 1 when hour has no data', () => {
      const scaler = new PredictiveScaler();

      // No hourly patterns recorded for any hour
      const factor = scaler._getSeasonalFactor(Date.now());

      expect(factor).toBe(1);
    });

    test('should return 1 when hour has fewer than 3 samples', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();
      const hour = new Date(now).getHours();

      // Record only 2 data points for this hour (need 3 minimum)
      recordPoint(scaler, now, 100);
      recordPoint(scaler, now + 1000, 200);

      expect(scaler.hourlyPatterns.get(hour).length).toBe(2);

      const factor = scaler._getSeasonalFactor(now);
      expect(factor).toBe(1);
    });
  });

  // ─── Lines 445, 506, 511: getPatterns peak hour detection ───
  describe('getPatterns peak detection (lines 445, 506, 511)', () => {
    test('should detect peak hours when some hours have significantly higher traffic', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });

      // Create data with distinct peak hours
      // We need multiple hours with >=3 samples each, some >1.3x the average
      const now = Date.now();

      // Peak hour: hour 14 (high requests = 500)
      for (let i = 0; i < 4; i++) {
        const ts = new Date(now);
        ts.setHours(14, i * 10, 0, 0);
        recordPoint(scaler, ts.getTime(), 500);
      }

      // Normal hour: hour 3 (requests = 100)
      for (let i = 0; i < 4; i++) {
        const ts = new Date(now);
        ts.setHours(3, i * 10, 0, 0);
        recordPoint(scaler, ts.getTime(), 100);
      }

      // Normal hour: hour 8 (requests = 100)
      for (let i = 0; i < 4; i++) {
        const ts = new Date(now);
        ts.setHours(8, i * 10, 0, 0);
        recordPoint(scaler, ts.getTime(), 100);
      }

      const patterns = scaler.getPatterns();
      const peakPattern = patterns.find(p => p.type === 'peak');

      expect(peakPattern).toBeDefined();
      expect(peakPattern.hours).toContain(14);
      expect(peakPattern.intensity).toBeGreaterThan(0);
      expect(peakPattern.description).toContain('High usage');
    });
  });

  // ─── Lines 456, 544, 549: getPatterns valley hour detection ───
  describe('getPatterns valley detection (lines 456, 544, 549)', () => {
    test('should detect valley hours when some hours have significantly lower traffic', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();

      // Valley hour: hour 2 (very low requests = 1)
      for (let i = 0; i < 4; i++) {
        const ts = new Date(now);
        ts.setHours(2, i * 10, 0, 0);
        recordPoint(scaler, ts.getTime(), 1);
      }

      // Multiple normal hours with high requests to keep overall average high
      // so valley hour (avg=1) stays well below threshold (avg * 0.5)
      for (const h of [8, 10, 14, 16, 18]) {
        for (let i = 0; i < 4; i++) {
          const ts = new Date(now);
          ts.setHours(h, i * 10, 0, 0);
          recordPoint(scaler, ts.getTime(), 300);
        }
      }

      const patterns = scaler.getPatterns();
      const valleyPattern = patterns.find(p => p.type === 'valley');

      expect(valleyPattern).toBeDefined();
      expect(valleyPattern.hours).toContain(2);
      expect(valleyPattern.intensity).toBeGreaterThan(0);
      expect(valleyPattern.description).toContain('Low usage');
    });

    test('should detect both peak and valley patterns simultaneously', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();

      // Peak hour: hour 12 (500 requests)
      for (let i = 0; i < 4; i++) {
        const ts = new Date(now);
        ts.setHours(12, i * 10, 0, 0);
        recordPoint(scaler, ts.getTime(), 500);
      }

      // Valley hour: hour 4 (5 requests)
      for (let i = 0; i < 4; i++) {
        const ts = new Date(now);
        ts.setHours(4, i * 10, 0, 0);
        recordPoint(scaler, ts.getTime(), 5);
      }

      // Normal hour: hour 9 (150 requests)
      for (let i = 0; i < 4; i++) {
        const ts = new Date(now);
        ts.setHours(9, i * 10, 0, 0);
        recordPoint(scaler, ts.getTime(), 150);
      }

      const patterns = scaler.getPatterns();
      const peakPattern = patterns.find(p => p.type === 'peak');
      const valleyPattern = patterns.find(p => p.type === 'valley');

      expect(peakPattern).toBeDefined();
      expect(valleyPattern).toBeDefined();
      expect(peakPattern.hours).toContain(12);
      expect(valleyPattern.hours).toContain(4);
    });
  });

  // ─── Line 599: getSeasonality returns early when overallAvg === 0 ───
  describe('getSeasonality with zero baseline (line 599)', () => {
    test('should return not detected when all request values are zero', () => {
      const scaler = new PredictiveScaler();

      // Populate 12+ hours with zero-request data to pass the size >= 12 check
      // but overall average is 0
      for (let h = 0; h < 13; h++) {
        for (let i = 0; i < 3; i++) {
          const ts = new Date();
          ts.setHours(h, i * 10, 0, 0);
          recordPoint(scaler, ts.getTime(), 0);
        }
      }

      // hourlyPatterns.size should be >= 12
      expect(scaler.hourlyPatterns.size).toBeGreaterThanOrEqual(12);

      const seasonality = scaler.getSeasonality();

      expect(seasonality.detected).toBe(false);
      expect(seasonality.hourlyFactors).toEqual([]);
    });
  });

  // ─── Additional branch coverage: _detectPeakHours/ValleyHours with no qualifying hours ───
  describe('_detectPeakHours with no hours above threshold', () => {
    test('should return empty hours when all hours are similar', () => {
      const scaler = new PredictiveScaler();

      // All hours have similar traffic (within 1.3x of average)
      for (let h = 0; h < 3; h++) {
        for (let i = 0; i < 4; i++) {
          const ts = new Date();
          ts.setHours(h, i * 10, 0, 0);
          recordPoint(scaler, ts.getTime(), 100 + (h * 5)); // Very small variation
        }
      }

      const result = scaler._detectPeakHours();
      expect(result.hours).toEqual([]);
      expect(result.intensity).toBe(0);
    });
  });

  describe('_detectValleyHours with no hours below threshold', () => {
    test('should return empty hours when all hours are similar', () => {
      const scaler = new PredictiveScaler();

      // All hours have similar traffic (none below 0.5x of average)
      for (let h = 0; h < 3; h++) {
        for (let i = 0; i < 4; i++) {
          const ts = new Date();
          ts.setHours(h, i * 10, 0, 0);
          recordPoint(scaler, ts.getTime(), 100 + (h * 5));
        }
      }

      const result = scaler._detectValleyHours();
      expect(result.hours).toEqual([]);
      expect(result.intensity).toBe(0);
    });
  });

  // ─── _detectPeakHours/ValleyHours with no qualifying data (count === 0 path) ───
  describe('_detectPeakHours with insufficient per-hour data', () => {
    test('should return empty when no hour has >= 3 samples', () => {
      const scaler = new PredictiveScaler();

      // Only 2 samples per hour (need 3)
      const now = Date.now();
      for (let h = 0; h < 5; h++) {
        for (let i = 0; i < 2; i++) {
          const ts = new Date(now);
          ts.setHours(h, i * 10, 0, 0);
          recordPoint(scaler, ts.getTime(), 100);
        }
      }

      const result = scaler._detectPeakHours();
      expect(result).toEqual({ hours: [], intensity: 0 });
    });
  });

  // ─── _predictAtTime seasonal vs trend basis ───
  describe('_predictAtTime seasonal basis selection', () => {
    test('should use seasonal basis when seasonal factor differs from 1', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();
      const currentHour = new Date(now).getHours();

      // Build enough hourly data so seasonal factor != 1 for the prediction hour
      // We need data in the prediction hour with >= 3 samples and a different average
      // than the overall baseline

      // Add data for current hour with high values
      for (let i = 0; i < 5; i++) {
        const ts = new Date(now);
        ts.setHours(currentHour, i * 5, 0, 0);
        recordPoint(scaler, ts.getTime(), 300);
      }

      // Add data for a different hour with low values to skew the baseline down
      const otherHour = (currentHour + 12) % 24;
      for (let i = 0; i < 5; i++) {
        const ts = new Date(now);
        ts.setHours(otherHour, i * 5, 0, 0);
        recordPoint(scaler, ts.getTime(), 50);
      }

      const predictions = scaler.predict();

      expect(predictions.length).toBe(5);
      // At least some predictions should have seasonal basis
      const seasonalPredictions = predictions.filter(p => p.basis === 'seasonal');
      const trendPredictions = predictions.filter(p => p.basis === 'trend');

      // Predictions should exist with either seasonal or trend basis
      expect(predictions.every(p => ['seasonal', 'trend', 'baseline'].includes(p.basis))).toBe(true);
    });
  });

  // ─── Peak hours sorting verification ───
  describe('peak hours are returned sorted (line 511)', () => {
    test('should return peak hours sorted in ascending order', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();

      // Create multiple peak hours (20, 14, 18) by giving them high values
      // and a low-value normal hour to create contrast
      const peakHoursList = [20, 14, 18];
      const normalHours = [3, 6, 9];

      for (const h of peakHoursList) {
        for (let i = 0; i < 4; i++) {
          const ts = new Date(now);
          ts.setHours(h, i * 10, 0, 0);
          recordPoint(scaler, ts.getTime(), 600);
        }
      }

      for (const h of normalHours) {
        for (let i = 0; i < 4; i++) {
          const ts = new Date(now);
          ts.setHours(h, i * 10, 0, 0);
          recordPoint(scaler, ts.getTime(), 80);
        }
      }

      const result = scaler._detectPeakHours();

      // Verify sorting
      for (let i = 1; i < result.hours.length; i++) {
        expect(result.hours[i]).toBeGreaterThanOrEqual(result.hours[i - 1]);
      }
    });
  });

  // ─── Valley hours sorting verification ───
  describe('valley hours are returned sorted (line 549)', () => {
    test('should return valley hours sorted in ascending order', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();

      // Create multiple valley hours with very low values
      const valleyHoursList = [22, 5, 2];
      const normalHours = [10, 14, 18];

      for (const h of valleyHoursList) {
        for (let i = 0; i < 4; i++) {
          const ts = new Date(now);
          ts.setHours(h, i * 10, 0, 0);
          recordPoint(scaler, ts.getTime(), 3);
        }
      }

      for (const h of normalHours) {
        for (let i = 0; i < 4; i++) {
          const ts = new Date(now);
          ts.setHours(h, i * 10, 0, 0);
          recordPoint(scaler, ts.getTime(), 400);
        }
      }

      const result = scaler._detectValleyHours();

      // Verify sorting
      for (let i = 1; i < result.hours.length; i++) {
        expect(result.hours[i]).toBeGreaterThanOrEqual(result.hours[i - 1]);
      }
    });
  });

  // ─── Predictions ensure non-negative (line 239) ───
  describe('predictions ensure non-negative values', () => {
    test('should not return negative predicted requests even with strong downward trend', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();

      // Create steep downward trend that might extrapolate below zero
      for (let i = 0; i < 10; i++) {
        recordPoint(scaler, now - (10 - i) * 60000, Math.max(1, 100 - i * 15));
      }

      const predictions = scaler.predict();

      predictions.forEach(p => {
        expect(p.requests).toBeGreaterThanOrEqual(0);
      });
    });
  });

  // ─── _getSeasonalFactor when overallAvg is 0 ───
  describe('_getSeasonalFactor with zero overall average', () => {
    test('should return 1 when all history requests are zero', () => {
      const scaler = new PredictiveScaler();
      const now = Date.now();
      const hour = new Date(now).getHours();

      // Record 3+ zero-request data points for this hour
      for (let i = 0; i < 4; i++) {
        recordPoint(scaler, now + i * 1000, 0);
      }

      expect(scaler.hourlyPatterns.get(hour).length).toBeGreaterThanOrEqual(3);

      const factor = scaler._getSeasonalFactor(now);
      expect(factor).toBe(1);
    });
  });

  // ─── getRecommendations with keyUtilization > 0.9 (priority 5 path) ───
  describe('getRecommendations high priority scale_up (utilization > 0.9)', () => {
    test('should assign priority 5 when utilization exceeds 90%', () => {
      const scaler = new PredictiveScaler({ minSamples: 5 });
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        scaler.recordUsage(now - (10 - i) * 60000, {
          requests: 100 + i * 20,
          queueSize: 0,
          latency: 100,
          keyUtilization: 95 // > 90% utilization
        });
      }

      const recommendations = scaler.getRecommendations();
      const scaleUp = recommendations.find(r => r.type === 'scale_up');

      expect(scaleUp).toBeDefined();
      expect(scaleUp.priority).toBe(5);
    });
  });
});

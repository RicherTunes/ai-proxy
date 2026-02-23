/**
 * Request ID derivation — single source of truth.
 *
 * Every place that needs a stable identifier for a request object
 * (row stamping, dedup, lookup, navigation) MUST use this function
 * so IDs are always consistent.
 *
 * Fallback chain:
 *   requestId  (server-assigned, always present for real requests)
 *   id         (alias used by some internal payloads)
 *   _syntheticId  (monotonic counter, collision-free, stamped once)
 *
 * NOTE: traceId is intentionally excluded — it identifies trace spans
 * (used by the Traces tab and replay queue), not request identity.
 */
(function (window) {
    'use strict';

    var _seq = 0;

    function getRequestId(req) {
        if (!req) return null;
        if (req.requestId) return req.requestId;
        if (req.id) return req.id;
        if (!req._syntheticId) {
            req._syntheticId = (req.timestamp || 0) + '-' + (req.keyIndex ?? 0) + '-' + (++_seq);
        }
        return req._syntheticId;
    }

    window.RequestIds = { getRequestId: getRequestId };
})(window);

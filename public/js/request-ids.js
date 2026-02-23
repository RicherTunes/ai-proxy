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
 *   timestamp-keyIndex  (synthetic, defensive only)
 */
(function (window) {
    'use strict';

    function getRequestId(req) {
        if (!req) return null;
        return req.requestId || req.id || (req.timestamp + '-' + (req.keyIndex ?? 0));
    }

    window.RequestIds = { getRequestId: getRequestId };
})(window);

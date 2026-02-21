'use strict';

/**
 * Client IP Resolution Module
 *
 * Resolves the true client IP from X-Forwarded-For headers,
 * using a trusted proxy list to prevent spoofing.
 *
 * Algorithm (standard right-to-left walk):
 * 1. Parse XFF into a list, append req.socket.remoteAddress
 * 2. Walk right-to-left, stripping trusted proxy entries
 * 3. First untrusted entry = client IP
 * 4. If all trusted (or no XFF), use remoteAddress
 *
 * Limitation: trustedProxies is exact IP match only (no CIDR).
 */

/**
 * Normalize an IP address for comparison.
 * - Maps IPv4-mapped IPv6 (::ffff:1.2.3.4) to plain IPv4 (1.2.3.4)
 * - Handles null/undefined gracefully
 * @param {string|null|undefined} ip
 * @returns {string}
 */
function normalizeIp(ip) {
    if (ip == null) return '';
    const str = String(ip).trim();
    // Strip IPv4-mapped IPv6 prefix
    const mapped = str.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return mapped[1];
    return str;
}

/**
 * Strip port suffix from an IP string.
 * - IPv4: "1.2.3.4:1234" -> "1.2.3.4"
 * - Bracketed IPv6: "[::1]:1234" -> "::1"
 * - Plain IPv6 or IPv4 without port: unchanged
 * @param {string} raw
 * @returns {string}
 */
function stripPort(raw) {
    const trimmed = raw.trim();
    // Bracketed IPv6 with port: [::1]:1234
    const bracketMatch = trimmed.match(/^\[(.+)\]:\d+$/);
    if (bracketMatch) return bracketMatch[1];
    // IPv4 with port: 1.2.3.4:1234 (must match x.x.x.x:port pattern)
    const ipv4PortMatch = trimmed.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
    if (ipv4PortMatch) return ipv4PortMatch[1];
    return trimmed;
}

/**
 * Parse an X-Forwarded-For header into a list of IPs.
 * @param {string|undefined} xff - Raw XFF header value
 * @returns {string[]} Parsed, trimmed, non-empty IP entries
 */
function parseXff(xff) {
    if (!xff) return [];
    return xff
        .split(',')
        .map(s => stripPort(s.trim()))
        .filter(s => s.length > 0);
}

// Cache for trusted proxy Set to avoid rebuilding on every request
let _cachedProxies = null;
let _cachedSet = null;

/**
 * Get cached trusted proxy Set or create new one if array reference changed.
 * Uses reference equality check for cache hit.
 * @param {string[]} trustedProxies - List of trusted proxy IPs
 * @returns {Set<string>} Set of normalized trusted IPs
 */
function getTrustedSet(trustedProxies) {
    if (trustedProxies === _cachedProxies && _cachedSet) {
        return _cachedSet;
    }
    _cachedSet = new Set(trustedProxies.map(ip => normalizeIp(ip)));
    _cachedProxies = trustedProxies;
    return _cachedSet;
}

/**
 * Get the true client IP from a request, respecting trusted proxies.
 *
 * @param {http.IncomingMessage} req - HTTP request object
 * @param {string[]} trustedProxies - List of trusted proxy IPs (exact match, pre-normalized recommended)
 * @returns {string} Client IP address
 */
function getClientIp(req, trustedProxies = []) {
    const remoteAddress = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    const normalizedRemote = normalizeIp(remoteAddress);

    // Build trusted set with normalized IPs for fast lookup (cached by reference)
    const trustedSet = getTrustedSet(trustedProxies);

    // If remoteAddress is NOT trusted, XFF cannot be trusted — return remoteAddress directly
    if (!trustedSet.has(normalizedRemote)) {
        return normalizedRemote || 'unknown';
    }

    // remoteAddress IS trusted — consult forwarded headers
    const xff = req.headers['x-forwarded-for'];
    const xffList = parseXff(xff);

    if (xffList.length === 0) {
        // No XFF header — try x-real-ip as fallback
        const xRealIp = req.headers['x-real-ip'];
        if (xRealIp) {
            return normalizeIp(stripPort(xRealIp.trim()));
        }
        return normalizedRemote || 'unknown';
    }

    // Append remoteAddress to the chain, then walk right-to-left stripping trusted
    const chain = [...xffList.map(ip => normalizeIp(ip)), normalizedRemote];

    // Walk from right to left, skip trusted entries
    for (let i = chain.length - 1; i >= 0; i--) {
        if (!trustedSet.has(chain[i])) {
            return chain[i];
        }
    }

    // All entries are trusted — return remoteAddress
    return normalizedRemote || 'unknown';
}

module.exports = { getClientIp, normalizeIp, parseXff, stripPort };

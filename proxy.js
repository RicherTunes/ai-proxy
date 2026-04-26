#!/usr/bin/env node
/**
 * GLM Proxy v2
 * Modular, testable API proxy with circuit breaker, rate limiting, and clustering
 */

const { startProxy } = require('./lib');
const { getLogger } = require('./lib/logger');

let proxyInstance = null;
let isShuttingDown = false;

// Deferred logger: not available until startProxy() completes, so process-level
// handlers fall back to console for pre-boot errors and use logger when available.
let logger = null;

function getProcessLogger() {
    if (!logger) {
        try { logger = getLogger(); } catch { /* pre-boot */ }
    }
    return logger;
}

// Crash protection: catch unhandled errors and attempt graceful shutdown
// Without these handlers, any unhandled exception kills the process instantly
// with no state save, no drain of in-flight requests, nothing.
process.on('uncaughtException', async (err) => {
    const log = getProcessLogger();
    if (log) {
        log.error('Uncaught exception', { error: err.message, stack: err.stack });
    } else {
        console.error('[FATAL] Uncaught exception:', err);
    }
    if (isShuttingDown) {
        if (log) {
            log.error('Already shutting down, forcing exit');
        } else {
            console.error('[FATAL] Already shutting down, forcing exit');
        }
        process.exit(1);
    }
    isShuttingDown = true;
    try {
        if (proxyInstance) {
            await proxyInstance.shutdown();
        }
    } catch (shutdownErr) {
        if (log) {
            log.error('Error during emergency shutdown', { error: shutdownErr.message });
        } else {
            console.error('[FATAL] Error during emergency shutdown:', shutdownErr);
        }
    }
    process.exit(1);
});

// Unhandled rejection escalation: track rejection count in a sliding window.
// If rejections exceed the threshold within the window, treat as critical and exit.
const REJECTION_WINDOW_MS = 60000;
const REJECTION_THRESHOLD = 10;
let rejectionCount = 0;
let rejectionWindowStart = Date.now();

process.on('unhandledRejection', (reason, promise) => {
    const log = getProcessLogger();
    const now = Date.now();

    // Reset window if expired
    if (now - rejectionWindowStart > REJECTION_WINDOW_MS) {
        rejectionCount = 0;
        rejectionWindowStart = now;
    }
    rejectionCount++;

    const reasonMsg = reason instanceof Error ? reason.message : String(reason);
    const reasonStack = reason instanceof Error ? reason.stack : undefined;

    if (log) {
        log.error('Unhandled promise rejection', {
            reason: reasonMsg,
            stack: reasonStack,
            rejectionCount,
            windowMs: REJECTION_WINDOW_MS
        });
    } else {
        console.error('[ERROR] Unhandled promise rejection:', reason);
    }

    // Escalate: too many rejections in the window indicates systemic failure
    if (rejectionCount >= REJECTION_THRESHOLD) {
        const msg = `CRITICAL: ${rejectionCount} unhandled rejections in ${REJECTION_WINDOW_MS}ms window, forcing exit`;
        if (log) {
            log.error(msg, { rejectionCount, threshold: REJECTION_THRESHOLD });
        } else {
            console.error(`[CRITICAL] ${msg}`);
        }
        process.exit(1);
    }
});

// Graceful shutdown on PM2/system signals
async function gracefulShutdown(signal) {
    console.log(`[INFO] Received ${signal}, initiating graceful shutdown...`);
    if (isShuttingDown) {
        console.log('[INFO] Already shutting down, ignoring duplicate signal');
        return;
    }
    isShuttingDown = true;
    try {
        if (proxyInstance) {
            await proxyInstance.shutdown();
        }
    } catch (err) {
        console.error('[ERROR] Error during graceful shutdown:', err);
    }
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// PM2 sends 'message' event with shutdown type when shutdown_with_message is enabled
process.on('message', (msg) => {
    if (msg === 'shutdown') {
        gracefulShutdown('PM2:shutdown');
    }
});

// Start the proxy
startProxy()
    .then((result) => {
        if (result.master) {
            console.log(`Master started with ${result.workers} workers`);
        } else {
            proxyInstance = result.proxy;
        }
    })
    .catch((err) => {
        console.error('Failed to start proxy:', err);
        process.exit(1);
    });

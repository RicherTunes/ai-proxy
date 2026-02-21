#!/usr/bin/env node
/**
 * GLM Proxy v2
 * Modular, testable API proxy with circuit breaker, rate limiting, and clustering
 */

const { startProxy } = require('./lib');

let proxyInstance = null;
let isShuttingDown = false;

// Crash protection: catch unhandled errors and attempt graceful shutdown
// Without these handlers, any unhandled exception kills the process instantly
// with no state save, no drain of in-flight requests, nothing.
process.on('uncaughtException', async (err) => {
    console.error('[FATAL] Uncaught exception:', err);
    if (isShuttingDown) {
        console.error('[FATAL] Already shutting down, forcing exit');
        process.exit(1);
    }
    isShuttingDown = true;
    try {
        if (proxyInstance) {
            await proxyInstance.shutdown();
        }
    } catch (shutdownErr) {
        console.error('[FATAL] Error during emergency shutdown:', shutdownErr);
    }
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[ERROR] Unhandled promise rejection:', reason);
    // Log but don't exit - unhandled rejections are often non-fatal.
    // Node.js v15+ treats these as uncaughtException by default,
    // but we handle them separately for better diagnostics.
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

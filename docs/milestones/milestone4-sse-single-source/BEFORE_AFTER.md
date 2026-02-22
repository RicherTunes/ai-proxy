---
layout: default
title: Milestone 4: Before/After Comparison
---

# Milestone 4: Before/After Comparison

## lib/request-handler.js

### Before (Lines 192-196)

```javascript
this.keyManager = options.keyManager;
this.statsAggregator = options.statsAggregator;
this.config = options.config || {};
this.logger = options.logger;
this.onRequestCallback = options.onRequest || null;  // SSE callback
```

### After (Lines 192-195)

```javascript
this.keyManager = options.keyManager;
this.statsAggregator = options.statsAggregator;
this.config = options.config || {};
this.logger = options.logger;
```

### Before (Lines 364-383 in addRequestToStream)

```javascript
this.requestStream.push(normalized);

// Keep only the most recent requests
while (this.requestStream.length > this.maxStreamSize) {
    this.requestStream.shift();
}

// Emit for event listeners
this.emit('request', normalized);

// Call SSE callback if provided (for dashboard live stream)
if (this.onRequestCallback) {
    try {
        this.onRequestCallback(normalized);
    } catch (err) {
        this.logger?.warn('SSE callback error', { error: err.message });
    }
}
```

### After (Lines 364-373)

```javascript
this.requestStream.push(normalized);

// Keep only the most recent requests
while (this.requestStream.length > this.maxStreamSize) {
    this.requestStream.shift();
}

// Emit for event listeners (SSE clients subscribe to this event)
this.emit('request', normalized);
```

## lib/proxy-server.js

### Before (Lines 52-58)

```javascript
this.requestHandler = new RequestHandler({
    keyManager: this.keyManager,
    statsAggregator: this.statsAggregator,
    config: this.config,
    logger: this.logger.child('proxy'),
    onRequest: (request) => this._broadcastRequest(request)  // SSE callback
});
```

### After (Lines 52-56)

```javascript
this.requestHandler = new RequestHandler({
    keyManager: this.keyManager,
    statsAggregator: this.statsAggregator,
    config: this.config,
    logger: this.logger.child('proxy')
});
```

### Before (Lines 88-93)

```javascript
// Setup request stream clients (PHASE 2 - Task #10)
this.sseClients = new Set();

// NOTE: Request events are broadcast via the onRequest callback passed to RequestHandler
// (see constructor above). We previously also listened to the 'request' event here,
// but that caused double-sending of SSE events. Now we use only the callback path.
```

### After (Lines 87-92)

```javascript
// Setup request stream clients (PHASE 2 - Task #10)
this.sseClients = new Set();

// Subscribe to RequestHandler 'request' events for SSE broadcast
// This is the SINGLE source of truth for request events (no dual emission)
this.requestHandler.on('request', (request) => this._broadcastRequest(request));
```

## Summary of Changes

### Removed

- ❌ `onRequestCallback` storage in RequestHandler constructor
- ❌ Callback invocation in `addRequestToStream()` method
- ❌ `onRequest` option passed from ProxyServer to RequestHandler
- ❌ Outdated comment about dual emission

### Added

- ✅ Event listener subscription: `requestHandler.on('request', ...)`
- ✅ Clear comment explaining single source of truth
- ✅ Comprehensive unit tests for single emission

### Kept

- ✅ EventEmitter emission: `this.emit('request', normalized)`
- ✅ Event normalization (latency alias, status mapping)
- ✅ Request stream buffer management
- ✅ SSE client management and cleanup

## Result

**Before:** Dual emission (EventEmitter + callback) caused duplicate events
**After:** Single emission (EventEmitter only) - one event per request

Each SSE client receives exactly one copy of each request event. No duplicates.

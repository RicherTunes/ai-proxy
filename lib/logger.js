/**
 * Logger Module
 * Structured logging with levels, request context, and multiple formats
 */

const { RingBuffer } = require('./ring-buffer');

const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

// Sensitive fields that should be masked in logs
const SENSITIVE_FIELDS = [
    'key', 'apiKey', 'api_key', 'secret', 'token', 'password',
    'authorization', 'x-api-key', 'bearer', 'credential', 'credentials'
];

// Pattern to detect API keys (alphanumeric with dots, typically 32+ chars)
// NOTE: Removed /g flag because .test() with global regex is stateful (updates lastIndex)
// which can cause intermittent false negatives when reusing the pattern
const API_KEY_PATTERN = /\b[a-zA-Z0-9]{20,}\.[a-zA-Z0-9]{10,}\b/;

class Logger {
    constructor(options = {}) {
        this.level = LOG_LEVELS[options.level?.toUpperCase()] ?? LOG_LEVELS.INFO;
        this.format = options.format || 'text';
        this.prefix = options.prefix || '';
        this.output = options.output || console;
        this.maxLogEntries = 100;
        this.logBuffer = new RingBuffer(this.maxLogEntries);
        this.sanitizeLogs = options.sanitizeLogs !== false; // Default true
    }

    /**
     * Mask a sensitive value for safe logging
     * Shows first 8 chars + *** to help identify which key without exposing it
     */
    _maskValue(value) {
        if (typeof value !== 'string') return value;
        if (value.length <= 8) return '***';
        return value.substring(0, 8) + '***';
    }

    /**
     * Check if a key name indicates sensitive data
     */
    _isSensitiveKey(key) {
        const lowerKey = key.toLowerCase();
        return SENSITIVE_FIELDS.some(sf => lowerKey.includes(sf));
    }

    /**
     * Recursively sanitize an object, masking sensitive fields
     */
    _sanitizeObject(obj, depth = 0) {
        if (depth > 10) return obj; // Prevent infinite recursion
        if (obj === null || obj === undefined) return obj;
        if (typeof obj !== 'object') {
            // Check if string looks like an API key
            if (typeof obj === 'string' && API_KEY_PATTERN.test(obj)) {
                return this._maskValue(obj);
            }
            return obj;
        }
        if (Array.isArray(obj)) {
            return obj.map(item => this._sanitizeObject(item, depth + 1));
        }

        const sanitized = {};
        for (const [key, value] of Object.entries(obj)) {
            const isSensitive = this._isSensitiveKey(key);

            if (typeof value === 'object' && value !== null) {
                // Always recurse into objects to find nested sensitive fields
                sanitized[key] = this._sanitizeObject(value, depth + 1);
            } else if (isSensitive && typeof value === 'string') {
                // Mask string values in sensitive fields
                sanitized[key] = this._maskValue(value);
            } else if (typeof value === 'string' && API_KEY_PATTERN.test(value)) {
                // Check if string value looks like an API key
                sanitized[key] = this._maskValue(value);
            } else {
                sanitized[key] = value;
            }
        }
        return sanitized;
    }

    /**
     * Sanitize context for logging (masks sensitive data)
     */
    _sanitizeContext(context) {
        if (!this.sanitizeLogs || !context) return context;
        return this._sanitizeObject(context);
    }

    _formatMessage(level, message, context = {}) {
        const timestamp = new Date().toISOString();
        const levelStr = Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === level);

        // Sanitize context before formatting
        const safeContext = this._sanitizeContext(context);

        if (this.format === 'json') {
            return JSON.stringify({
                timestamp,
                level: levelStr,
                prefix: this.prefix || undefined,
                message,
                ...safeContext
            });
        }

        // Text format
        let line = `[${timestamp}]`;
        if (this.prefix) line += ` [${this.prefix}]`;
        line += ` [${levelStr}]`;
        if (safeContext.requestId) line += ` [${safeContext.requestId}]`;
        line += ` ${message}`;

        // Append additional context
        const extraKeys = Object.keys(safeContext).filter(k => k !== 'requestId');
        if (extraKeys.length > 0) {
            const extras = extraKeys.map(k => `${k}=${JSON.stringify(safeContext[k])}`).join(' ');
            line += ` (${extras})`;
        }

        return line;
    }

    _log(level, message, context) {
        if (level < this.level) return;

        // Sanitize context for storage (never store raw sensitive data)
        const safeContext = this._sanitizeContext(context);

        // Store in buffer for /logs endpoint
        const entry = {
            timestamp: new Date().toISOString(),
            level: Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === level),
            message: message,
            context: safeContext || null,
            prefix: this.prefix
        };
        this.logBuffer.push(entry);

        const formatted = this._formatMessage(level, message, context);

        if (level >= LOG_LEVELS.ERROR) {
            this.output.error(formatted);
        } else if (level >= LOG_LEVELS.WARN) {
            this.output.warn ? this.output.warn(formatted) : this.output.log(formatted);
        } else {
            this.output.log(formatted);
        }
    }

    debug(message, context) {
        this._log(LOG_LEVELS.DEBUG, message, context);
    }

    info(message, context) {
        this._log(LOG_LEVELS.INFO, message, context);
    }

    warn(message, context) {
        this._log(LOG_LEVELS.WARN, message, context);
    }

    error(message, context) {
        this._log(LOG_LEVELS.ERROR, message, context);
    }

    getLogs(limit = 100) {
        const allLogs = this.logBuffer.toArray();
        const count = Math.min(limit, allLogs.length);
        return allLogs.slice(-count);
    }

    clearLogs() {
        this.logBuffer.clear();
    }

    // Create a child logger with additional prefix
    child(prefix) {
        const childPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix;
        const childLogger = new Logger({
            level: Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === this.level),
            format: this.format,
            prefix: childPrefix,
            output: this.output
        });
        childLogger.logBuffer = this.logBuffer;
        childLogger.maxLogEntries = this.maxLogEntries;
        return childLogger;
    }

    // Create request-scoped logger
    forRequest(requestId) {
        const reqLogger = new Logger({
            level: Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === this.level),
            format: this.format,
            prefix: this.prefix,
            output: this.output
        });
        reqLogger.requestId = requestId;

        // Share the parent's logBuffer so logs appear in /logs endpoint
        reqLogger.logBuffer = this.logBuffer;
        reqLogger.maxLogEntries = this.maxLogEntries;

        // Override log methods to include requestId
        const originalLog = reqLogger._log.bind(reqLogger);
        reqLogger._log = (level, message, context = {}) => {
            originalLog(level, message, { requestId, ...context });
        };

        return reqLogger;
    }

    setLevel(level) {
        this.level = LOG_LEVELS[level?.toUpperCase()] ?? LOG_LEVELS.INFO;
    }
}

// Request ID generator
let requestCounter = 0;

function generateRequestId() {
    const timestamp = Date.now().toString(36);
    const counter = (++requestCounter % 0xFFFF).toString(16).padStart(4, '0');
    const random = Math.random().toString(36).substring(2, 6);
    return `${timestamp}-${counter}-${random}`;
}

// Singleton instance
let instance = null;

function getLogger(options) {
    if (!instance || options) {
        instance = new Logger(options);
    }
    return instance;
}

function resetLogger() {
    instance = null;
}

module.exports = {
    Logger,
    LOG_LEVELS,
    SENSITIVE_FIELDS,
    getLogger,
    resetLogger,
    generateRequestId,
    API_KEY_PATTERN
};

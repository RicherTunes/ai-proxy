'use strict';
/**
 * Logger Edge-Case Tests
 *
 * Covers: level filtering, JSON format, text format, component prefix,
 * child loggers, circular references, large payloads, redaction,
 * rate-limiting (not implemented — verified), and runtime reconfiguration.
 */

const { Logger, LOG_LEVELS, getLogger, resetLogger } = require('../lib/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeMock() {
    return {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    };
}

// ---------------------------------------------------------------------------
// 1. Log-level filtering
// ---------------------------------------------------------------------------
describe('Log-level filtering', () => {
    let out;
    beforeEach(() => { out = makeMock(); });

    test('DEBUG level allows all four levels through', () => {
        const log = new Logger({ level: 'DEBUG', output: out });
        log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
        // debug + info go to log, warn to warn, error to error
        expect(out.log).toHaveBeenCalledTimes(2);
        expect(out.warn).toHaveBeenCalledTimes(1);
        expect(out.error).toHaveBeenCalledTimes(1);
    });

    test('INFO level suppresses DEBUG', () => {
        const log = new Logger({ level: 'INFO', output: out });
        log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
        expect(out.log).toHaveBeenCalledTimes(1);   // info only
        expect(out.warn).toHaveBeenCalledTimes(1);
        expect(out.error).toHaveBeenCalledTimes(1);
    });

    test('WARN level suppresses DEBUG and INFO', () => {
        const log = new Logger({ level: 'WARN', output: out });
        log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
        expect(out.log).toHaveBeenCalledTimes(0);
        expect(out.warn).toHaveBeenCalledTimes(1);
        expect(out.error).toHaveBeenCalledTimes(1);
    });

    test('ERROR level suppresses everything except ERROR', () => {
        const log = new Logger({ level: 'ERROR', output: out });
        log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
        expect(out.log).toHaveBeenCalledTimes(0);
        expect(out.warn).toHaveBeenCalledTimes(0);
        expect(out.error).toHaveBeenCalledTimes(1);
    });

    test('suppressed messages are not stored in the log buffer', () => {
        const log = new Logger({ level: 'ERROR', output: out });
        log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
        const entries = log.getLogs();
        expect(entries).toHaveLength(1);
        expect(entries[0].level).toBe('ERROR');
    });
});

// ---------------------------------------------------------------------------
// 2. JSON format output
// ---------------------------------------------------------------------------
describe('JSON format output', () => {
    let out;
    beforeEach(() => { out = makeMock(); });

    test('output is valid JSON with expected fields', () => {
        const log = new Logger({ level: 'INFO', format: 'json', prefix: 'SVC', output: out });
        log.info('hello', { extra: 42 });

        const raw = out.log.mock.calls[0][0];
        const parsed = JSON.parse(raw);  // will throw if invalid JSON

        expect(parsed).toHaveProperty('timestamp');
        expect(parsed).toHaveProperty('level', 'INFO');
        expect(parsed).toHaveProperty('prefix', 'SVC');
        expect(parsed).toHaveProperty('message', 'hello');
        expect(parsed).toHaveProperty('extra', 42);
    });

    test('timestamp is a valid ISO-8601 string', () => {
        const log = new Logger({ level: 'INFO', format: 'json', output: out });
        log.info('ts-check');
        const parsed = JSON.parse(out.log.mock.calls[0][0]);
        expect(() => new Date(parsed.timestamp)).not.toThrow();
        expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });

    test('prefix is omitted from JSON when empty', () => {
        const log = new Logger({ level: 'INFO', format: 'json', output: out });
        log.info('no prefix');
        const parsed = JSON.parse(out.log.mock.calls[0][0]);
        expect(parsed.prefix).toBeUndefined();
    });

    test('JSON error messages go to output.error', () => {
        const log = new Logger({ level: 'DEBUG', format: 'json', output: out });
        log.error('boom');
        const parsed = JSON.parse(out.error.mock.calls[0][0]);
        expect(parsed.level).toBe('ERROR');
    });

    test('JSON warn messages go to output.warn', () => {
        const log = new Logger({ level: 'DEBUG', format: 'json', output: out });
        log.warn('caution');
        const parsed = JSON.parse(out.warn.mock.calls[0][0]);
        expect(parsed.level).toBe('WARN');
    });
});

// ---------------------------------------------------------------------------
// 3. Text format output
// ---------------------------------------------------------------------------
describe('Text format output', () => {
    let out;
    beforeEach(() => { out = makeMock(); });

    test('text line contains timestamp, level, and message', () => {
        const log = new Logger({ level: 'INFO', format: 'text', output: out });
        log.info('hello world');

        const line = out.log.mock.calls[0][0];
        // timestamp pattern [YYYY-MM-DDTHH:MM:SS.mmmZ]
        expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
        expect(line).toContain('[INFO]');
        expect(line).toContain('hello world');
    });

    test('text line includes component prefix when set', () => {
        const log = new Logger({ level: 'INFO', format: 'text', prefix: 'PROXY', output: out });
        log.info('msg');
        expect(out.log.mock.calls[0][0]).toContain('[PROXY]');
    });

    test('text line omits prefix brackets when prefix is empty', () => {
        const log = new Logger({ level: 'INFO', format: 'text', prefix: '', output: out });
        log.info('msg');
        const line = out.log.mock.calls[0][0];
        // Should not have two consecutive "] [" where the first would be prefix
        const segments = line.match(/\[.*?\]/g);
        // Should have timestamp and level only (no prefix bracket)
        expect(segments.length).toBe(2); // [timestamp] [LEVEL]
    });

    test('extra context keys appear in parentheses', () => {
        const log = new Logger({ level: 'INFO', format: 'text', output: out });
        log.info('msg', { foo: 'bar', count: 3 });
        const line = out.log.mock.calls[0][0];
        expect(line).toContain('foo="bar"');
        expect(line).toContain('count=3');
    });

    test('text-format primitive optimisation: numbers and booleans skip JSON.stringify', () => {
        const log = new Logger({ level: 'INFO', format: 'text', output: out });
        log.info('perf', { num: 42, flag: true, neg: -3.14, zero: 0, off: false });
        const line = out.log.mock.calls[0][0];
        // Numbers and booleans must render identically to JSON.stringify output
        expect(line).toContain('num=42');
        expect(line).toContain('flag=true');
        expect(line).toContain('neg=-3.14');
        expect(line).toContain('zero=0');
        expect(line).toContain('off=false');
        // Strings should still be JSON-quoted
        log.info('str', { label: 'hello' });
        const line2 = out.log.mock.calls[1][0];
        expect(line2).toContain('label="hello"');
    });

    test('text-format null and undefined context values render correctly', () => {
        const log = new Logger({ level: 'INFO', format: 'text', output: out });
        log.info('edge', { a: null });
        const line = out.log.mock.calls[0][0];
        expect(line).toContain('a=null');
    });
});

// ---------------------------------------------------------------------------
// 4. Component prefix
// ---------------------------------------------------------------------------
describe('Component prefix', () => {
    let out;
    beforeEach(() => { out = makeMock(); });

    test('prefix appears in every log call', () => {
        const log = new Logger({ level: 'DEBUG', prefix: 'AUTH', output: out });
        log.debug('d'); log.info('i'); log.warn('w'); log.error('e');

        const allCalls = [
            ...out.log.mock.calls.map(c => c[0]),
            ...out.warn.mock.calls.map(c => c[0]),
            ...out.error.mock.calls.map(c => c[0])
        ];
        allCalls.forEach(line => expect(line).toContain('[AUTH]'));
    });

    test('prefix is stored in log buffer entries', () => {
        const log = new Logger({ level: 'INFO', prefix: 'BUF', output: out });
        log.info('stored');
        expect(log.getLogs()[0].prefix).toBe('BUF');
    });
});

// ---------------------------------------------------------------------------
// 5. Child loggers
// ---------------------------------------------------------------------------
describe('Child loggers', () => {
    let out;
    beforeEach(() => { out = makeMock(); });

    test('child inherits parent level and format', () => {
        const parent = new Logger({ level: 'WARN', format: 'json', output: out });
        const child = parent.child('DB');
        expect(child.level).toBe(LOG_LEVELS.WARN);
        expect(child.format).toBe('json');
    });

    test('child prefix is parent:child', () => {
        const parent = new Logger({ level: 'INFO', prefix: 'APP', output: out });
        const child = parent.child('DB');
        expect(child.prefix).toBe('APP:DB');
    });

    test('grandchild prefix chains correctly', () => {
        const root = new Logger({ level: 'INFO', prefix: 'ROOT', output: out });
        const mid = root.child('MID');
        const leaf = mid.child('LEAF');
        expect(leaf.prefix).toBe('ROOT:MID:LEAF');
    });

    test('child shares log buffer with parent', () => {
        const parent = new Logger({ level: 'INFO', output: out });
        const child = parent.child('C');
        child.info('from child');
        expect(parent.getLogs()).toHaveLength(1);
        expect(parent.getLogs()[0].message).toBe('from child');
    });

    test('child with no parent prefix uses own prefix directly', () => {
        const parent = new Logger({ level: 'INFO', output: out });
        const child = parent.child('SOLO');
        expect(child.prefix).toBe('SOLO');
    });

    test('child logger messages carry child prefix in output', () => {
        const parent = new Logger({ level: 'INFO', prefix: 'P', output: out });
        const child = parent.child('C');
        child.info('hi');
        expect(out.log.mock.calls[0][0]).toContain('[P:C]');
    });
});

// ---------------------------------------------------------------------------
// 6. Circular references
// ---------------------------------------------------------------------------
describe('Circular reference handling', () => {
    let out;
    beforeEach(() => { out = makeMock(); });

    test('logging object with circular reference in text mode throws (no built-in guard)', () => {
        const log = new Logger({ level: 'INFO', format: 'text', output: out });
        const obj = { a: 1 };
        obj.self = obj; // circular

        // _formatMessage stringifies context values via JSON.stringify inside the
        // extras section, and _sanitizeObject iterates via Object.entries which
        // doesn't itself throw on circular refs, but JSON.stringify in the text
        // line's extras will. Verify behaviour:
        // The _sanitizeObject depth guard (depth > 10) returns the raw object,
        // but at depth 0-1 it will recurse. Since circular objects will keep
        // hitting the same reference, the depth counter will eventually hit 10
        // and return the raw circular object. Then JSON.stringify on that in
        // _formatMessage will throw.
        expect(() => log.info('circ', obj)).toThrow();
    });

    test('logging object with circular reference in json mode throws', () => {
        const log = new Logger({ level: 'INFO', format: 'json', output: out });
        const obj = { a: 1 };
        obj.self = obj;

        expect(() => log.info('circ', obj)).toThrow();
    });

    test('deeply nested but non-circular object does not throw', () => {
        const log = new Logger({ level: 'INFO', format: 'text', output: out });
        let deep = {};
        let cur = deep;
        for (let i = 0; i < 8; i++) {
            cur.child = { val: i };
            cur = cur.child;
        }
        expect(() => log.info('deep', deep)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// 7. Large payloads
// ---------------------------------------------------------------------------
describe('Large payload handling', () => {
    let out;
    beforeEach(() => { out = makeMock(); });

    test('large string message is logged without truncation', () => {
        const log = new Logger({ level: 'INFO', output: out });
        const big = 'x'.repeat(100_000);
        log.info(big);
        expect(out.log.mock.calls[0][0]).toContain(big);
    });

    test('object with many keys is logged completely', () => {
        const log = new Logger({ level: 'INFO', format: 'json', output: out });
        const ctx = {};
        for (let i = 0; i < 500; i++) ctx[`k${i}`] = i;
        log.info('big ctx', ctx);
        const parsed = JSON.parse(out.log.mock.calls[0][0]);
        expect(parsed.k0).toBe(0);
        expect(parsed.k499).toBe(499);
    });

    test('large array in context is logged', () => {
        const log = new Logger({ level: 'INFO', format: 'json', output: out });
        const arr = Array.from({ length: 1000 }, (_, i) => i);
        log.info('arr', { items: arr });
        const parsed = JSON.parse(out.log.mock.calls[0][0]);
        expect(parsed.items).toHaveLength(1000);
    });

    test('log buffer ring-buffer still works after many entries', () => {
        const log = new Logger({ level: 'DEBUG', output: out });
        for (let i = 0; i < 200; i++) log.debug(`msg-${i}`);
        const logs = log.getLogs();
        // maxLogEntries is 100
        expect(logs.length).toBeLessThanOrEqual(100);
        // Most recent entry should be the last one written
        expect(logs[logs.length - 1].message).toBe('msg-199');
    });
});

// ---------------------------------------------------------------------------
// 8. Redaction of sensitive fields
// ---------------------------------------------------------------------------
describe('Redaction of sensitive fields', () => {
    let out;
    beforeEach(() => { out = makeMock(); });

    test('apiKey is redacted in text output', () => {
        const log = new Logger({ level: 'INFO', output: out });
        log.info('req', { apiKey: 'sk-1234567890abcdef' });
        const line = out.log.mock.calls[0][0];
        expect(line).not.toContain('sk-1234567890abcdef');
        expect(line).toContain('sk-12345***');
    });

    test('token is redacted in JSON output', () => {
        const log = new Logger({ level: 'INFO', format: 'json', output: out });
        log.info('auth', { token: 'bearer_abcdefghij123' });
        const parsed = JSON.parse(out.log.mock.calls[0][0]);
        expect(parsed.token).toBe('bearer_a***');
    });

    test('password is redacted', () => {
        const log = new Logger({ level: 'INFO', output: out });
        log.info('login', { password: 'hunter2_extended' });
        const line = out.log.mock.calls[0][0];
        expect(line).not.toContain('hunter2_extended');
        expect(line).toContain('hunter2_***');
    });

    test('nested sensitive field is redacted', () => {
        const log = new Logger({ level: 'INFO', format: 'json', output: out });
        log.info('nested', { config: { db: { password: 'supersecret123' } } });
        const parsed = JSON.parse(out.log.mock.calls[0][0]);
        expect(parsed.config.db.password).toBe('supersec***');
    });

    test('sensitive field inside array element is redacted', () => {
        const log = new Logger({ level: 'INFO', format: 'json', output: out });
        log.info('list', { providers: [{ apiKey: 'longapikey12345678' }] });
        const parsed = JSON.parse(out.log.mock.calls[0][0]);
        expect(parsed.providers[0].apiKey).toBe('longapik***');
    });

    test('short sensitive values are fully masked', () => {
        const log = new Logger({ level: 'INFO', format: 'json', output: out });
        log.info('short', { apiKey: 'abc' });
        const parsed = JSON.parse(out.log.mock.calls[0][0]);
        expect(parsed.apiKey).toBe('***');
    });

    test('API key pattern in non-sensitive field name is still detected', () => {
        const log = new Logger({ level: 'INFO', format: 'json', output: out });
        log.info('pattern', { data: 'abcdefghijklmnopqrstuvwxyz123456.secretpart1234567890' });
        const parsed = JSON.parse(out.log.mock.calls[0][0]);
        expect(parsed.data).toBe('abcdefgh***');
    });

    test('non-sensitive fields are NOT redacted', () => {
        const log = new Logger({ level: 'INFO', format: 'json', output: out });
        log.info('safe', { method: 'POST', path: '/api/v1/chat', status: 200 });
        const parsed = JSON.parse(out.log.mock.calls[0][0]);
        expect(parsed.method).toBe('POST');
        expect(parsed.path).toBe('/api/v1/chat');
        expect(parsed.status).toBe(200);
    });

    test('redaction in log buffer matches redaction in output', () => {
        const log = new Logger({ level: 'INFO', output: out });
        log.info('both', { apiKey: 'consistent_redaction_key' });
        const bufEntry = log.getLogs()[0];
        expect(bufEntry.context.apiKey).toBe('consiste***');
    });

    test('sanitizeLogs=false disables all redaction', () => {
        const log = new Logger({ level: 'INFO', output: out, sanitizeLogs: false });
        log.info('raw', { apiKey: 'visible_in_logs_key' });
        const bufEntry = log.getLogs()[0];
        expect(bufEntry.context.apiKey).toBe('visible_in_logs_key');
    });
});

// ---------------------------------------------------------------------------
// 9. Rate limiting (not implemented — verify absence)
// ---------------------------------------------------------------------------
describe('Rate limiting (current behaviour)', () => {
    let out;
    beforeEach(() => { out = makeMock(); });

    test('repeated identical messages are NOT suppressed (no rate-limiting)', () => {
        const log = new Logger({ level: 'INFO', output: out });
        for (let i = 0; i < 50; i++) log.info('same message');
        // All 50 should be emitted because rate-limiting is not implemented
        expect(out.log).toHaveBeenCalledTimes(50);
    });

    test('all repeated messages are stored in the buffer', () => {
        const log = new Logger({ level: 'INFO', output: out });
        for (let i = 0; i < 50; i++) log.info('same');
        expect(log.getLogs()).toHaveLength(50);
    });
});

// ---------------------------------------------------------------------------
// 10. Reset / reconfigure at runtime
// ---------------------------------------------------------------------------
describe('Runtime reconfiguration via setLevel', () => {
    let out;
    beforeEach(() => { out = makeMock(); });

    test('raising level suppresses previously allowed messages', () => {
        const log = new Logger({ level: 'DEBUG', output: out });
        log.debug('before');
        expect(out.log).toHaveBeenCalledTimes(1);

        log.setLevel('ERROR');
        log.debug('after');
        log.info('after');
        log.warn('after');
        expect(out.log).toHaveBeenCalledTimes(1); // no new log calls
        expect(out.warn).toHaveBeenCalledTimes(0);
    });

    test('lowering level allows previously suppressed messages', () => {
        const log = new Logger({ level: 'ERROR', output: out });
        log.info('suppressed');
        expect(out.log).toHaveBeenCalledTimes(0);

        log.setLevel('DEBUG');
        log.debug('now visible');
        expect(out.log).toHaveBeenCalledTimes(1);
    });

    test('setLevel accepts lowercase', () => {
        const log = new Logger({ level: 'ERROR', output: out });
        log.setLevel('debug');
        log.debug('lower');
        expect(out.log).toHaveBeenCalledTimes(1);
    });

    test('setLevel with undefined falls back to INFO', () => {
        const log = new Logger({ level: 'DEBUG', output: out });
        log.setLevel(undefined);
        expect(log.level).toBe(LOG_LEVELS.INFO);
    });

    test('setLevel with invalid string falls back to INFO', () => {
        const log = new Logger({ level: 'DEBUG', output: out });
        log.setLevel('BANANA');
        expect(log.level).toBe(LOG_LEVELS.INFO);
    });

    test('reconfiguring does not clear existing log buffer', () => {
        const log = new Logger({ level: 'INFO', output: out });
        log.info('before reconfig');
        log.setLevel('ERROR');
        log.info('suppressed');
        expect(log.getLogs()).toHaveLength(1);
        expect(log.getLogs()[0].message).toBe('before reconfig');
    });

    test('singleton getLogger can be reconfigured via resetLogger', () => {
        resetLogger();
        const a = getLogger({ level: 'DEBUG' });
        expect(a.level).toBe(LOG_LEVELS.DEBUG);

        resetLogger();
        const b = getLogger({ level: 'ERROR' });
        expect(b.level).toBe(LOG_LEVELS.ERROR);
        expect(b).not.toBe(a);
    });
});

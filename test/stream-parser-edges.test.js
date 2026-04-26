'use strict';

const { parseTokenUsage } = require('../lib/request/stream-parser');

describe('stream-parser edge cases', () => {

    describe('cross-chunk SSE split', () => {
        test('data: line split across two chunks reassembles when both in last chunk', () => {
            // parseTokenUsage only reads the LAST chunk, so a true cross-chunk split
            // where the first chunk ends with "dat" and the second starts with "a: {...}"
            // means the second chunk alone lacks the "data:" prefix.
            const chunk1 = Buffer.from('dat');
            const chunk2 = Buffer.from('a: {"usage":{"input_tokens":10,"output_tokens":20}}\n\n');

            // Only last chunk is read — incomplete line won't parse
            const result = parseTokenUsage([chunk1, chunk2]);
            expect(result).toBeNull();
        });

        test('concatenated chunks in a single buffer parse correctly', () => {
            // If the caller concatenates chunks before passing, it works
            const combined = Buffer.from(
                'data: {"type":"content_block_delta"}\n\n' +
                'data: {"usage":{"input_tokens":10,"output_tokens":20}}\n\n'
            );
            const result = parseTokenUsage([combined]);
            expect(result).toEqual({ input_tokens: 10, output_tokens: 20 });
        });
    });

    describe('multiple events in one chunk', () => {
        test('three complete SSE events — usage extracted from last one', () => {
            const chunk = Buffer.from(
                'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n' +
                'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n' +
                'data: {"usage":{"input_tokens":100,"output_tokens":250}}\n\n'
            );
            const result = parseTokenUsage([chunk]);
            expect(result).toEqual({ input_tokens: 100, output_tokens: 250 });
        });

        test('usage in middle event is still found (reverse scan)', () => {
            const chunk = Buffer.from(
                'data: {"type":"message_start"}\n\n' +
                'data: {"usage":{"input_tokens":50,"output_tokens":75}}\n\n' +
                'data: {"type":"message_stop"}\n\n'
            );
            const result = parseTokenUsage([chunk]);
            expect(result).toEqual({ input_tokens: 50, output_tokens: 75 });
        });
    });

    describe('empty data field', () => {
        test('data: followed by empty line is skipped gracefully', () => {
            const chunk = Buffer.from(
                'data: \n\n' +
                'data: {"usage":{"input_tokens":5,"output_tokens":10}}\n\n'
            );
            const result = parseTokenUsage([chunk]);
            expect(result).toEqual({ input_tokens: 5, output_tokens: 10 });
        });

        test('only empty data events returns null', () => {
            const chunk = Buffer.from('data: \n\ndata: \n\n');
            const result = parseTokenUsage([chunk]);
            expect(result).toBeNull();
        });
    });

    describe('very large single event', () => {
        test('1MB event payload parses correctly', () => {
            const bigContent = 'x'.repeat(1024 * 1024);
            const payload = {
                type: 'content_block_delta',
                delta: { text: bigContent },
                usage: { input_tokens: 999, output_tokens: 8888 }
            };
            const chunk = Buffer.from('data: ' + JSON.stringify(payload) + '\n\n');
            const result = parseTokenUsage([chunk]);
            expect(result).toEqual({ input_tokens: 999, output_tokens: 8888 });
        });
    });

    describe('usage extraction from final SSE event', () => {
        test('extracts usage from message_stop event (Anthropic format)', () => {
            const chunk = Buffer.from(
                'data: {"type":"content_block_stop","index":0}\n\n' +
                'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n' +
                'data: {"type":"message_stop","anthropic":{"usage":{"input_tokens":100,"output_tokens":200}}}\n\n'
            );
            const result = parseTokenUsage([chunk]);
            expect(result).toEqual({ input_tokens: 100, output_tokens: 200 });
        });

        test('extracts usage from direct format in final event', () => {
            const chunk = Buffer.from(
                'data: {"type":"message_start"}\n\n' +
                'data: {"type":"message_stop","usage":{"input_tokens":300,"output_tokens":400}}\n\n'
            );
            const result = parseTokenUsage([chunk]);
            expect(result).toEqual({ input_tokens: 300, output_tokens: 400 });
        });

        test('extracts OpenAI-compatible prompt_tokens/completion_tokens', () => {
            const chunk = Buffer.from(
                'data: {"usage":{"prompt_tokens":150,"completion_tokens":350}}\n\n'
            );
            const result = parseTokenUsage([chunk]);
            expect(result).toEqual({ input_tokens: 150, output_tokens: 350 });
        });

        test('[DONE] sentinel is skipped', () => {
            const chunk = Buffer.from(
                'data: {"usage":{"input_tokens":10,"output_tokens":20}}\n\n' +
                'data: [DONE]\n\n'
            );
            const result = parseTokenUsage([chunk]);
            expect(result).toEqual({ input_tokens: 10, output_tokens: 20 });
        });
    });

    describe('malformed SSE', () => {
        test('missing data: prefix — line is ignored', () => {
            const chunk = Buffer.from(
                '{"usage":{"input_tokens":10,"output_tokens":20}}\n\n'
            );
            // No "data:" prefix, so SSE parsing skips it.
            // Falls through to Strategy 2 (single JSON parse), which succeeds.
            const result = parseTokenUsage([chunk]);
            expect(result).toEqual({ input_tokens: 10, output_tokens: 20 });
        });

        test('no double newline separator — still parses data: lines', () => {
            const chunk = Buffer.from(
                'data: {"type":"start"}\ndata: {"usage":{"input_tokens":5,"output_tokens":15}}\n'
            );
            const result = parseTokenUsage([chunk]);
            expect(result).toEqual({ input_tokens: 5, output_tokens: 15 });
        });

        test('corrupted JSON in data line is skipped', () => {
            const chunk = Buffer.from(
                'data: {corrupted json\n\n' +
                'data: {"usage":{"input_tokens":1,"output_tokens":2}}\n\n'
            );
            const result = parseTokenUsage([chunk]);
            expect(result).toEqual({ input_tokens: 1, output_tokens: 2 });
        });

        test('all lines corrupted returns null', () => {
            const chunk = Buffer.from(
                'data: {bad1\n\ndata: {bad2\n\n'
            );
            const result = parseTokenUsage([chunk]);
            expect(result).toBeNull();
        });
    });

    describe('binary / non-UTF8 data', () => {
        test('non-UTF8 bytes in stream do not crash', () => {
            const binaryChunk = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc0, 0xc1]);
            expect(() => parseTokenUsage([binaryChunk])).not.toThrow();
            const result = parseTokenUsage([binaryChunk]);
            expect(result).toBeNull();
        });

        test('mixed binary prefix and valid SSE — binary corrupts data: prefix', () => {
            // Leading binary bytes become part of the first line when toString() splits on \n,
            // so the "data:" prefix is not at position 0 and the SSE line is skipped.
            const binary = Buffer.from([0xff, 0xfe, 0x00]);
            const valid = Buffer.from(
                'data: {"usage":{"input_tokens":7,"output_tokens":14}}\n\n'
            );
            const combined = Buffer.concat([binary, valid]);
            expect(() => parseTokenUsage([combined])).not.toThrow();
            // First line is garbled — "data:" not at start, so SSE parse skips it
            const result = parseTokenUsage([combined]);
            expect(result).toBeNull();
        });

        test('binary between valid SSE events — second event still parses', () => {
            const valid1 = Buffer.from('data: {"type":"start"}\n');
            const binary = Buffer.from([0xff, 0xfe]);
            const valid2 = Buffer.from('\ndata: {"usage":{"input_tokens":7,"output_tokens":14}}\n\n');
            const combined = Buffer.concat([valid1, binary, valid2]);
            expect(() => parseTokenUsage([combined])).not.toThrow();
            const result = parseTokenUsage([combined]);
            expect(result).toEqual({ input_tokens: 7, output_tokens: 14 });
        });
    });

    describe('edge input cases', () => {
        test('empty array returns null', () => {
            expect(parseTokenUsage([])).toBeNull();
        });

        test('non-array returns null', () => {
            expect(parseTokenUsage(null)).toBeNull();
            expect(parseTokenUsage(undefined)).toBeNull();
            expect(parseTokenUsage('string')).toBeNull();
        });

        test('array with null element returns null', () => {
            expect(parseTokenUsage([null])).toBeNull();
        });

        test('non-streaming JSON response (direct object)', () => {
            const json = JSON.stringify({
                id: 'msg_123',
                usage: { input_tokens: 50, output_tokens: 100 }
            });
            const chunk = Buffer.from(json);
            const result = parseTokenUsage([chunk]);
            expect(result).toEqual({ input_tokens: 50, output_tokens: 100 });
        });
    });
});

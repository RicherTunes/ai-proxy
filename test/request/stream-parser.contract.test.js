/**
 * Contract Test: Stream Parser
 *
 * This contract test ensures that token usage parsing produces consistent results
 * after extraction from RequestHandler to stream-parser.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const { parseTokenUsage } = require('../../lib/request/stream-parser');

describe('RequestHandler Contract: Token Usage Parsing', () => {
    describe('should parse Anthropic SSE format', () => {
        it('should parse message_stop with anthropic.usage', () => {
            const chunks = [
                Buffer.from('event: message_stop\ndata: {"type":"message_stop","anthropic":{"usage":{"input_tokens":100,"output_tokens":50}}}\n\n')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toEqual({
                input_tokens: 100,
                output_tokens: 50
            });
        });

        it('should parse usage field directly', () => {
            const chunks = [
                Buffer.from('event: message_stop\ndata: {"type":"message_stop","usage":{"input_tokens":200,"output_tokens":75}}\n\n')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toEqual({
                input_tokens: 200,
                output_tokens: 75
            });
        });
    });

    describe('should handle edge cases', () => {
        it('should return null for empty array', () => {
            const result = parseTokenUsage([]);
            expect(result).toBeNull();
        });

        it('should return null for non-array input', () => {
            const result = parseTokenUsage(null);
            expect(result).toBeNull();

            const result2 = parseTokenUsage(undefined);
            expect(result2).toBeNull();

            const result3 = parseTokenUsage('not an array');
            expect(result3).toBeNull();
        });

        it('should return null for array with empty chunks', () => {
            const result = parseTokenUsage([Buffer.from('')]);
            expect(result).toBeNull();
        });

        it('should skip [DONE] markers', () => {
            const chunks = [
                Buffer.from('data: [DONE]\n\n')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toBeNull();
        });

        it('should handle malformed JSON gracefully', () => {
            const chunks = [
                Buffer.from('data: {invalid json}\n\n')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toBeNull();
        });

        it('should handle chunks without usage data', () => {
            const chunks = [
                Buffer.from('data: {"type":"message_delta"}\n\n')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toBeNull();
        });

        it('should handle zero token counts', () => {
            const chunks = [
                Buffer.from('data: {"anthropic":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toEqual({
                input_tokens: 0,
                output_tokens: 0
            });
        });

        it('should look at the last chunk for usage info', () => {
            const chunks = [
                Buffer.from('data: {"type":"message_start"}\n\n'),
                Buffer.from('data: {"type":"content_block_delta"}\n\n'),
                Buffer.from('data: {"type":"message_stop","anthropic":{"usage":{"input_tokens":150,"output_tokens":80}}}\n\n')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toEqual({
                input_tokens: 150,
                output_tokens: 80
            });
        });
    });

    describe('evidence field contract', () => {
        it('should preserve token count structure', () => {
            const chunks = [
                Buffer.from('data: {"anthropic":{"usage":{"input_tokens":123,"output_tokens":456}}}\n\n')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toHaveProperty('input_tokens');
            expect(result).toHaveProperty('output_tokens');
            expect(typeof result.input_tokens).toBe('number');
            expect(typeof result.output_tokens).toBe('number');
        });
    });
});

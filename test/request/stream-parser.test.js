/**
 * Unit Test: Stream Parser Module
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the pure function parseTokenUsage() which extracts
 * token usage parsing logic from RequestHandler.
 */

'use strict';

const { parseTokenUsage } = require('../../lib/request/stream-parser');

describe('stream-parser', () => {
    describe('parseTokenUsage', () => {
        describe('Anthropic SSE format', () => {
            it('should parse anthropic.usage format', () => {
                const chunks = [
                    Buffer.from('event: message_stop\ndata: {"type":"message_stop","anthropic":{"usage":{"input_tokens":100,"output_tokens":50}}}\n\n')
                ];
                const result = parseTokenUsage(chunks);
                expect(result).toEqual({
                    input_tokens: 100,
                    output_tokens: 50
                });
            });

            it('should parse direct usage format', () => {
                const chunks = [
                    Buffer.from('data: {"usage":{"input_tokens":200,"output_tokens":75}}\n\n')
                ];
                const result = parseTokenUsage(chunks);
                expect(result).toEqual({
                    input_tokens: 200,
                    output_tokens: 75
                });
            });

            it('should look at last chunk for usage info', () => {
                const chunks = [
                    Buffer.from('data: {"type":"message_start"}\n\n'),
                    Buffer.from('data: {"type":"content_block_delta"}\n\n'),
                    Buffer.from('data: {"type":"message_stop","anthropic":{"usage":{"input_tokens":300,"output_tokens":100}}}\n\n')
                ];
                const result = parseTokenUsage(chunks);
                expect(result).toEqual({
                    input_tokens: 300,
                    output_tokens: 100
                });
            });
        });

        describe('OpenAI-compatible format (z.ai)', () => {
            it('should parse prompt_tokens/completion_tokens format', () => {
                const chunks = [
                    Buffer.from('data: {"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\n')
                ];
                const result = parseTokenUsage(chunks);
                expect(result).toEqual({
                    input_tokens: 100,
                    output_tokens: 50
                });
            });

            it('should prefer input_tokens over prompt_tokens when both present', () => {
                const chunks = [
                    Buffer.from('data: {"usage":{"input_tokens":200,"output_tokens":75,"prompt_tokens":100,"completion_tokens":50}}\n\n')
                ];
                const result = parseTokenUsage(chunks);
                expect(result).toEqual({
                    input_tokens: 200,
                    output_tokens: 75
                });
            });

            it('should handle only prompt_tokens with zero completion_tokens', () => {
                const chunks = [
                    Buffer.from('data: {"usage":{"prompt_tokens":500,"completion_tokens":0,"total_tokens":500}}\n\n')
                ];
                const result = parseTokenUsage(chunks);
                expect(result).toEqual({
                    input_tokens: 500,
                    output_tokens: 0
                });
            });
        });

        describe('Edge cases', () => {
            it('should return null for empty array', () => {
                const result = parseTokenUsage([]);
                expect(result).toBeNull();
            });

            it('should return null for non-array', () => {
                expect(parseTokenUsage(null)).toBeNull();
                expect(parseTokenUsage(undefined)).toBeNull();
                expect(parseTokenUsage('string')).toBeNull();
                expect(parseTokenUsage({})).toBeNull();
            });

            it('should return null for array with empty buffer', () => {
                const result = parseTokenUsage([Buffer.from('')]);
                expect(result).toBeNull();
            });

            it('should skip [DONE] markers', () => {
                const chunks = [Buffer.from('data: [DONE]\n\n')];
                const result = parseTokenUsage(chunks);
                expect(result).toBeNull();
            });

            it('should handle malformed JSON gracefully', () => {
                const chunks = [Buffer.from('data: {invalid json}\n\n')];
                const result = parseTokenUsage(chunks);
                expect(result).toBeNull();
            });

            it('should return null when no usage data present', () => {
                const chunks = [Buffer.from('data: {"type":"message_delta"}\n\n')];
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

            it('should handle missing token fields with defaults', () => {
                const chunks = [
                    Buffer.from('data: {"anthropic":{"usage":{}}}\n\n')
                ];
                const result = parseTokenUsage(chunks);
                expect(result).toEqual({
                    input_tokens: 0,
                    output_tokens: 0
                });
            });
        });

        describe('Multi-line SSE chunks', () => {
            it('should parse multiple data lines', () => {
                const chunks = [
                    Buffer.from('data: {"type":"delta"}\ndata: {"anthropic":{"usage":{"input_tokens":500,"output_tokens":250}}}\n\n')
                ];
                const result = parseTokenUsage(chunks);
                expect(result).toEqual({
                    input_tokens: 500,
                    output_tokens: 250
                });
            });

            it('should handle mixed event types', () => {
                const chunks = [
                    Buffer.from('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n'),
                    Buffer.from('event: message_stop\ndata: {"type":"message_stop","anthropic":{"usage":{"input_tokens":1000,"output_tokens":500}}}\n\n')
                ];
                const result = parseTokenUsage(chunks);
                expect(result).toEqual({
                    input_tokens: 1000,
                    output_tokens: 500
                });
            });
        });
    });
});

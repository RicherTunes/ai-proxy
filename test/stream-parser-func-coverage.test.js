'use strict';

/**
 * Branch Coverage Tests for stream-parser.js
 *
 * Target: Push branch coverage from 96.66% to 100%
 * Missing branch: Line 61 - JSON parses successfully but usage is null (no usage fields)
 */

const { parseTokenUsage } = require('../lib/request/stream-parser');

describe('stream-parser branch coverage', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('Strategy 2: Non-streaming JSON', () => {
        // Covers line 61: JSON parses successfully but has no usage fields (null branch)
        it('should return null when valid JSON has no usage fields', () => {
            const chunks = [
                Buffer.from('{"id":"msg_123","type":"message","role":"assistant"}')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toBeNull();
        });

        // Covers line 61: JSON with anthropic key but no usage sub-key
        it('should return null when JSON has anthropic key but no usage sub-key', () => {
            const chunks = [
                Buffer.from('{"anthropic":{"model":"claude-3-opus"},"id":"123"}')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toBeNull();
        });

        // Covers line 61: JSON with empty usage object
        it('should return zero tokens when usage object exists but is empty', () => {
            const chunks = [
                Buffer.from('{"usage":{}}')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toEqual({
                input_tokens: 0,
                output_tokens: 0
            });
        });

        // Covers line 61: Non-streaming JSON with anthropic.usage (success branch)
        it('should parse non-streaming JSON with anthropic.usage', () => {
            const chunks = [
                Buffer.from('{"id":"msg_123","type":"message","anthropic":{"usage":{"input_tokens":150,"output_tokens":75}}}')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toEqual({
                input_tokens: 150,
                output_tokens: 75
            });
        });

        // Covers line 61: Non-streaming JSON with direct usage (success branch)
        it('should parse non-streaming JSON with direct usage', () => {
            const chunks = [
                Buffer.from('{"id":"msg_456","usage":{"input_tokens":300,"output_tokens":120}}')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toEqual({
                input_tokens: 300,
                output_tokens: 120
            });
        });

        // Covers line 61: Non-streaming JSON with prompt_tokens/completion_tokens
        it('should parse non-streaming JSON with OpenAI-compatible usage', () => {
            const chunks = [
                Buffer.from('{"id":"msg_789","usage":{"prompt_tokens":400,"completion_tokens":200}}')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toEqual({
                input_tokens: 400,
                output_tokens: 200
            });
        });
    });

    describe('Edge: Falsy lastChunk', () => {
        // Covers line 35: Array with explicit null/undefined last element
        it('should return null when last chunk is null', () => {
            const chunks = [Buffer.from('data: {"usage":{}}\n\n'), null];
            const result = parseTokenUsage(chunks);
            expect(result).toBeNull();
        });
    });

    describe('SSE with valid JSON but no usage', () => {
        // Covers line 51: SSE data line parses but has no usage
        it('should return null for SSE with valid JSON but no usage fields', () => {
            const chunks = [
                Buffer.from('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toBeNull();
        });
    });

    describe('Empty data string handling', () => {
        // Covers line 46: data: with only whitespace (trimmed to empty)
        it('should skip data: lines with only whitespace', () => {
            const chunks = [
                Buffer.from('data:   \n\n')
            ];
            const result = parseTokenUsage(chunks);
            expect(result).toBeNull();
        });
    });
});

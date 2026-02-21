/**
 * Stream Parser Module
 *
 * Pure function for parsing token usage from SSE (Server-Sent Events) streams.
 * Extracted from RequestHandler for better testability and reusability.
 *
 * Supported Formats:
 * - Anthropic: data.anthropic.usage.input_tokens/output_tokens
 * - Direct: data.usage.input_tokens/output_tokens
 * - OpenAI-compatible (z.ai): data.usage.prompt_tokens/completion_tokens
 * - Non-streaming JSON: top-level usage object
 *
 * @module request/stream-parser
 */

'use strict';

/**
 * Parse token usage from API response chunks.
 *
 * Handles both SSE streaming responses and non-streaming JSON responses.
 * For SSE, searches from the END of the buffer (usage appears in final events).
 * Each data line is parsed independently so one bad line doesn't break the whole parse.
 *
 * @param {Array<Buffer>} chunks - Array of response chunks
 * @returns {Object|null} Token usage object with input_tokens and output_tokens, or null if not found
 */
function parseTokenUsage(chunks) {
    // Guard against invalid input
    if (!Array.isArray(chunks) || chunks.length === 0) {
        return null;
    }

    const lastChunk = chunks[chunks.length - 1];
    if (!lastChunk) return null;

    const text = lastChunk.toString();

    // Strategy 1: Parse as SSE stream (data: lines) — search from END for efficiency
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.startsWith('data:')) continue;

        const dataStr = line.slice(5).trim();
        if (dataStr === '[DONE]' || dataStr === '') continue;

        try {
            const data = JSON.parse(dataStr);
            const usage = _extractUsage(data);
            if (usage) return usage;
        } catch (_e) {
            // Individual line parse failure — continue to next line
        }
    }

    // Strategy 2: Try parsing entire text as a single JSON object (non-streaming response)
    try {
        const data = JSON.parse(text);
        const usage = _extractUsage(data);
        if (usage) return usage;
    } catch (_e) {
        // Not a single JSON object — that's fine
    }

    return null;
}

/**
 * Extract token usage from a parsed JSON object.
 * Checks Anthropic, direct, and OpenAI-compatible formats.
 *
 * @param {Object} data - Parsed JSON object
 * @returns {Object|null} { input_tokens, output_tokens } or null
 */
function _extractUsage(data) {
    // Anthropic nested format
    if (data.anthropic?.usage) {
        return {
            input_tokens: data.anthropic.usage.input_tokens || 0,
            output_tokens: data.anthropic.usage.output_tokens || 0
        };
    }
    // Direct / OpenAI-compatible format
    if (data.usage) {
        return {
            input_tokens: data.usage.input_tokens || data.usage.prompt_tokens || 0,
            output_tokens: data.usage.output_tokens || data.usage.completion_tokens || 0
        };
    }
    return null;
}

module.exports = {
    parseTokenUsage
};

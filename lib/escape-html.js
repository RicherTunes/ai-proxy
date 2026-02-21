'use strict';

/**
 * HTML entity escape map.
 * Covers all characters that could be interpreted as HTML/JS in innerHTML context.
 */
const ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
    '`': '&#x60;'
};

const ESCAPE_REGEX = /[&<>"'`/]/g;

/**
 * Escape a string for safe inclusion in HTML.
 *
 * Use this when you must use innerHTML with dynamic values.
 * Prefer using DOM APIs (createElement + textContent) when possible.
 *
 * @param {*} str - Value to escape (non-strings become empty string)
 * @returns {string} HTML-escaped string
 *
 * @example
 * // Unsafe:
 * element.innerHTML = `<span>${userInput}</span>`;
 *
 * // Safe:
 * element.innerHTML = `<span>${escapeHtml(userInput)}</span>`;
 */
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(ESCAPE_REGEX, char => ESCAPE_MAP[char]);
}

/**
 * Escape a string for safe inclusion in a JavaScript string literal.
 * Useful when embedding data in inline scripts.
 *
 * @param {*} str - Value to escape
 * @returns {string} JS-escaped string (without quotes)
 */
function escapeJs(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/</g, '\\x3C')   // Prevent </script> breaking out
        .replace(/>/g, '\\x3E');
}

/**
 * Create a safe text node and return its content.
 * This is browser-only; use escapeHtml in Node.js.
 *
 * @param {*} str - Value to escape
 * @returns {string} HTML-escaped string
 */
function escapeHtmlViaDOM(str) {
    if (typeof document === 'undefined') {
        return escapeHtml(str);
    }
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

module.exports = { escapeHtml, escapeJs, escapeHtmlViaDOM };

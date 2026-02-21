'use strict';

const { escapeHtml, escapeJs, escapeHtmlViaDOM } = require('../lib/escape-html');

describe('escapeHtml', () => {
    it('escapes & character', () => {
        expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
        expect(escapeHtml('&&')).toBe('&amp;&amp;');
    });

    it('escapes < and > characters', () => {
        expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
        expect(escapeHtml('a < b > c')).toBe('a &lt; b &gt; c');
    });

    it('escapes quote characters', () => {
        expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
        expect(escapeHtml("'world'")).toBe('&#x27;world&#x27;');
    });

    it('escapes forward slash', () => {
        expect(escapeHtml('</script>')).toBe('&lt;&#x2F;script&gt;');
    });

    it('escapes backtick', () => {
        expect(escapeHtml('`code`')).toBe('&#x60;code&#x60;');
    });

    it('handles empty string', () => {
        expect(escapeHtml('')).toBe('');
    });

    it('returns empty string for non-strings', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
        expect(escapeHtml(123)).toBe('');
        expect(escapeHtml({})).toBe('');
        expect(escapeHtml([])).toBe('');
    });

    it('preserves safe characters', () => {
        expect(escapeHtml('hello world')).toBe('hello world');
        expect(escapeHtml('abc123')).toBe('abc123');
        expect(escapeHtml('foo-bar_baz')).toBe('foo-bar_baz');
    });

    it('escapes mixed content', () => {
        const input = '<img src="x" onerror="alert(\'xss\')">';
        const expected = '&lt;img src=&quot;x&quot; onerror=&quot;alert(&#x27;xss&#x27;)&quot;&gt;';
        expect(escapeHtml(input)).toBe(expected);
    });

    it('handles XSS attack vectors', () => {
        // Script injection
        expect(escapeHtml('<script>alert(1)</script>')).not.toContain('<script>');

        // Event handler injection
        expect(escapeHtml('onclick="evil()"')).not.toContain('onclick="');

        // SVG injection
        expect(escapeHtml('<svg onload="evil()">')).not.toContain('<svg');

        // Data URI
        expect(escapeHtml('javascript:evil()')).toBe('javascript:evil()');  // URLs are handled separately
    });

    it('handles unicode correctly', () => {
        expect(escapeHtml('café')).toBe('café');
        expect(escapeHtml('日本語')).toBe('日本語');
        expect(escapeHtml('emoji: 🎉')).toBe('emoji: 🎉');
    });
});

describe('escapeJs', () => {
    it('escapes backslash', () => {
        expect(escapeJs('a\\b')).toBe('a\\\\b');
    });

    it('escapes quotes', () => {
        expect(escapeJs("it's")).toBe("it\\'s");
        expect(escapeJs('"hi"')).toBe('\\"hi\\"');
    });

    it('escapes newlines and tabs', () => {
        expect(escapeJs('a\nb')).toBe('a\\nb');
        expect(escapeJs('a\rb')).toBe('a\\rb');
        expect(escapeJs('a\tb')).toBe('a\\tb');
    });

    it('escapes script-breaking characters', () => {
        expect(escapeJs('</script>')).toBe('\\x3C/script\\x3E');
        expect(escapeJs('<script>')).toBe('\\x3Cscript\\x3E');
    });

    it('handles empty string', () => {
        expect(escapeJs('')).toBe('');
    });

    it('returns empty string for non-strings', () => {
        expect(escapeJs(null)).toBe('');
        expect(escapeJs(undefined)).toBe('');
        expect(escapeJs(123)).toBe('');
    });

    it('handles mixed content', () => {
        const input = "alert('xss');\nconsole.log(\"test\")";
        const escaped = escapeJs(input);
        expect(escaped).not.toContain('\n');
        expect(escaped).toContain("\\'");
        expect(escaped).toContain('\\"');
    });
});

describe('escapeHtmlViaDOM', () => {
    it('falls back to escapeHtml in Node.js (no document)', () => {
        // In Node.js, document is undefined, so it should fall back to escapeHtml
        expect(escapeHtmlViaDOM('<script>alert(1)</script>')).toBe(escapeHtml('<script>alert(1)</script>'));
        expect(escapeHtmlViaDOM('foo & bar')).toBe('foo &amp; bar');
    });

    it('handles non-string input in fallback path', () => {
        expect(escapeHtmlViaDOM(null)).toBe('');
        expect(escapeHtmlViaDOM(undefined)).toBe('');
    });

    it('uses DOM when document is available', () => {
        // Temporarily mock document
        const origDocument = global.document;
        global.document = {
            createElement: jest.fn().mockReturnValue({
                set textContent(val) { this._text = val; },
                get innerHTML() { return this._text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
            })
        };

        try {
            const result = escapeHtmlViaDOM('<b>bold</b>');
            expect(global.document.createElement).toHaveBeenCalledWith('div');
            expect(result).toContain('&lt;');
        } finally {
            global.document = origDocument;
        }
    });
});

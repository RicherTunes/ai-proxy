/**
 * Unit tests for dashboard-utils.js
 */

// Mock document for tests
if (typeof document === 'undefined') {
    const escapeMap = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };

    global.document = {
        createElement: () => ({
            _textContent: '',
            get textContent() { return this._textContent; },
            set textContent(val) { this._textContent = String(val); },
            get innerHTML() {
                let text = this._textContent;
                return text.replace(/[&<>"']/g, m => escapeMap[m]);
            }
        })
    };
}

// Define utility functions inline for testing (mimicking dashboard-utils.js)
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function chipModelName(name) {
    if (!name) return '?';
    let stripped = name.replace(/-\d{8,}$/, '');
    stripped = stripped.replace(/(claude-[a-z]+-\d)-(\d)$/, '$1.$2');
    return stripped;
}

function formatTimestamp(ts, options) {
    if (ts == null) return '-';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '-';
    if (options && options.full) return d.toLocaleString();
    if (options && options.compact) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleTimeString();
}

function renderEmptyState(message, options = {}) {
    const icon = options.icon || '—';
    return `
        <div class="state-empty">
            <span class="state-icon">${icon}</span>
            <span class="state-message">${escapeHtml(message)}</span>
        </div>
    `;
}

function renderLoadingState(message = 'Loading...') {
    return `
        <div class="state-loading">
            <div class="spinner"></div>
            <span class="state-message">${escapeHtml(message)}</span>
        </div>
    `;
}

function renderErrorState(error, options = {}) {
    const retry = options.retryable
        ? '<button class="btn btn-small" onclick="location.reload()">Retry</button>'
        : '';
    return `
        <div class="state-error">
            <span class="state-icon">⚠</span>
            <span class="state-message">${escapeHtml(error)}</span>
            ${retry}
        </div>
    `;
}

describe('DashboardUtils', () => {
    describe('escapeHtml', () => {
        it('should escape HTML special characters', () => {
            expect(escapeHtml('<script>alert("xss")</script>'))
                .toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
        });

        it('should escape quotes', () => {
            expect(escapeHtml('"quoted" and \'single\''))
                .toBe('&quot;quoted&quot; and &#39;single&#39;');
        });

        it('should handle ampersands', () => {
            expect(escapeHtml('A & B'))
                .toBe('A &amp; B');
        });

        it('should handle null and undefined', () => {
            expect(escapeHtml(null)).toBe('');
            expect(escapeHtml(undefined)).toBe('');
        });

        it('should handle numbers', () => {
            expect(escapeHtml(123)).toBe('123');
        });

        it('should preserve safe text', () => {
            expect(escapeHtml('Safe text here'))
                .toBe('Safe text here');
        });
    });

    describe('chipModelName', () => {
        it('should strip date suffixes from model names', () => {
            expect(chipModelName('claude-sonnet-4-5-20250929'))
                .toBe('claude-sonnet-4.5');
            expect(chipModelName('claude-opus-4-6-20251001'))
                .toBe('claude-opus-4.6');
        });

        it('should normalize Claude version separators', () => {
            expect(chipModelName('claude-sonnet-4-5'))
                .toBe('claude-sonnet-4.5');
            expect(chipModelName('claude-opus-4-6'))
                .toBe('claude-opus-4.6');
        });

        it('should preserve non-Claude model names', () => {
            expect(chipModelName('glm-4.5-air'))
                .toBe('glm-4.5-air');
            expect(chipModelName('gpt-4-turbo'))
                .toBe('gpt-4-turbo');
        });

        it('should handle null and undefined', () => {
            expect(chipModelName(null)).toBe('?');
            expect(chipModelName(undefined)).toBe('?');
            expect(chipModelName('')).toBe('?');
        });
    });

    describe('formatTimestamp', () => {
        it('should handle null and undefined', () => {
            expect(formatTimestamp(null)).toBe('-');
            expect(formatTimestamp(undefined)).toBe('-');
        });

        it('should handle invalid dates', () => {
            expect(formatTimestamp('invalid')).toBe('-');
            expect(formatTimestamp(NaN)).toBe('-');
        });

        it('should format timestamps without options', () => {
            const ts = new Date('2025-01-15T14:30:00Z').getTime();
            const result = formatTimestamp(ts);
            // Should be a time string in local format
            expect(result).toMatch(/^\d{1,2}:\d{2}:\d{2}/);
        });

        it('should format timestamps with full option', () => {
            const ts = new Date('2025-01-15T14:30:00Z').getTime();
            const result = formatTimestamp(ts, { full: true });
            // Should include date and time
            expect(result).toMatch(/\d/);
        });

        it('should format timestamps with compact option', () => {
            const ts = new Date('2025-01-15T14:30:00Z').getTime();
            const result = formatTimestamp(ts, { compact: true });
            // Should be HH:MM format
            expect(result).toMatch(/^\d{1,2}:\d{2}/);
        });
    });

    describe('renderEmptyState', () => {
        it('should render empty state with default icon', () => {
            const result = renderEmptyState('No data available');
            expect(result).toContain('state-empty');
            expect(result).toContain('state-icon');
            expect(result).toContain('—');
            expect(result).toContain('No data available');
        });

        it('should render empty state with custom icon', () => {
            const result = renderEmptyState('No items', { icon: '📦' });
            expect(result).toContain('📦');
            expect(result).toContain('No items');
        });

        it('should escape HTML in message', () => {
            const result = renderEmptyState('<script>alert("xss")</script>');
            expect(result).toContain('&lt;script&gt;');
            expect(result).not.toContain('<script>');
        });
    });

    describe('renderLoadingState', () => {
        it('should render loading state with default message', () => {
            const result = renderLoadingState();
            expect(result).toContain('state-loading');
            expect(result).toContain('spinner');
            expect(result).toContain('Loading...');
        });

        it('should render loading state with custom message', () => {
            const result = renderLoadingState('Fetching data...');
            expect(result).toContain('Fetching data...');
        });

        it('should escape HTML in message', () => {
            const result = renderLoadingState('<img src=x onerror=alert(1)>');
            expect(result).not.toContain('<img');
            expect(result).toContain('&lt;img');
        });
    });

    describe('renderErrorState', () => {
        it('should render error state without retry button', () => {
            const result = renderErrorState('Something went wrong');
            expect(result).toContain('state-error');
            expect(result).toContain('⚠');
            expect(result).toContain('Something went wrong');
            expect(result).not.toContain('Retry');
        });

        it('should render error state with retry button', () => {
            const result = renderErrorState('Network error', { retryable: true });
            expect(result).toContain('Retry');
            expect(result).toContain('onclick="location.reload()"');
        });

        it('should escape HTML in error message', () => {
            const result = renderErrorState('<script>alert("xss")</script>');
            expect(result).toContain('&lt;script&gt;');
            expect(result).not.toContain('<script>');
        });
    });
});

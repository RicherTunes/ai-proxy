/**
 * AI Proxy Documentation Search
 * Client-side search using Fuse.js for fuzzy matching
 */

(function() {
    'use strict';

    // Search state
    let fuse = null;
    let searchIndex = [];

    // DOM elements
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    const searchOverlay = document.getElementById('search-overlay');
    const searchToggle = document.getElementById('search-toggle');

    /**
     * Initialize search functionality
     */
    async function initSearch() {
        try {
            // Load search index
            const response = await fetch('/ai-proxy/search/index.json');
            if (!response.ok) {
                throw new Error('Failed to load search index');
            }
            searchIndex = await response.json();

            // Initialize Fuse.js with custom options
            const fuseOptions = {
                keys: [
                    { name: 'title', weight: 3.0 },      // Title matches are most important
                    { name: 'content', weight: 1.5 },    // Content matches
                    { name: 'category', weight: 2.0 },   // Category matches
                    { name: 'tags', weight: 1.8 }        // Tag matches
                ],
                threshold: 0.4,        // Lower = more strict matching (0.0 = exact, 1.0 = match anything)
                distance: 100,         // How far to search for pattern matches
                minMatchCharLength: 2, // Minimum characters to trigger search
                includeMatches: true,  // Include match locations for highlighting
                includeScore: true,
                ignoreLocation: false  // Consider location when scoring
            };

            fuse = new Fuse(searchIndex, fuseOptions);
            console.log('Search initialized with', searchIndex.length, 'documents');

            // Set up event listeners
            if (searchInput) {
                searchInput.addEventListener('input', debounce(performSearch, 300));
                searchInput.addEventListener('keydown', handleKeyboard);
            }

            if (searchToggle) {
                searchToggle.addEventListener('click', toggleSearch);
            }

            if (searchOverlay) {
                searchOverlay.addEventListener('click', (e) => {
                    if (e.target === searchOverlay) {
                        closeSearch();
                    }
                });
            }

            // Close search on Escape key
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && searchOverlay && !searchOverlay.classList.contains('hidden')) {
                    closeSearch();
                }
            });

        } catch (error) {
            console.error('Failed to initialize search:', error);
            if (searchResults) {
                searchResults.innerHTML = '<p class="search-error">Search unavailable. Please check your connection.</p>';
            }
        }
    }

    /**
     * Perform search query
     */
    function performSearch() {
        const query = searchInput.value.trim();

        if (!query || query.length < 2) {
            if (searchResults) {
                searchResults.innerHTML = '';
            }
            return;
        }

        // Perform fuzzy search
        const results = fuse.search(query);

        // Display results
        displayResults(results, query);
    }

    /**
     * Display search results with highlighting
     */
    function displayResults(results, query) {
        if (!searchResults) return;

        if (results.length === 0) {
            searchResults.innerHTML = `
                <div class="search-no-results">
                    <p>No results found for "<strong>${escapeHtml(query)}</strong>"</p>
                    <p class="search-suggestions">Try:</p>
                    <ul>
                        <li>Using different keywords</li>
                        <li>Checking for typos</li>
                        <li>Using more general terms</li>
                    </ul>
                </div>
            `;
            return;
        }

        // Build results HTML
        const html = results.map((result, index) => {
            const item = result.item;
            const score = result.score;
            const relevance = Math.round((1 - score) * 100);

            // Highlight title
            const highlightedTitle = highlightText(item.title, result.matches, 'title');

            // Highlight and truncate content snippet
            let snippet = '';
            if (item.content) {
                const contentMatch = result.matches.find(m => m.key === 'content');
                if (contentMatch && contentMatch.indices) {
                    snippet = extractSnippet(item.content, contentMatch.indices, 150);
                    snippet = highlightText(snippet, result.matches, 'content');
                } else {
                    snippet = truncateText(item.content, 150);
                }
            }

            return `
                <div class="search-result-item" data-index="${index}">
                    <a href="${item.url}" class="search-result-link">
                        <div class="search-result-title">${highlightedTitle}</div>
                        ${item.category ? `<div class="search-result-category">${escapeHtml(item.category)}</div>` : ''}
                        ${snippet ? `<div class="search-result-snippet">${snippet}...</div>` : ''}
                        <div class="search-result-meta">
                            ${item.tags && item.tags.length > 0 ? `
                                <span class="search-result-tags">
                                    ${item.tags.slice(0, 3).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
                                </span>
                            ` : ''}
                            <span class="search-result-relevance">${relevance}% relevant</span>
                        </div>
                    </a>
                </div>
            `;
        }).join('');

        searchResults.innerHTML = `
            <div class="search-results-header">
                Found ${results.length} result${results.length !== 1 ? 's' : ''} for "<strong>${escapeHtml(query)}</strong>"
            </div>
            <div class="search-results-list">
                ${html}
            </div>
        `;
    }

    /**
     * Extract content snippet around matches
     */
    function extractSnippet(content, indices, maxLength) {
        if (!indices || indices.length === 0) {
            return truncateText(content, maxLength);
        }

        // Get first match location
        const [start, end] = indices[0];
        const contextLength = 50;

        // Calculate snippet bounds with context
        let snippetStart = Math.max(0, start - contextLength);
        let snippetEnd = Math.min(content.length, end + contextLength);

        let snippet = content.substring(snippetStart, snippetEnd);

        // Add ellipsis if truncated
        if (snippetStart > 0) {
            snippet = '...' + snippet;
        }
        if (snippetEnd < content.length) {
            snippet = snippet + '...';
        }

        return snippet.trim();
    }

    /**
     * Highlight matched text
     */
    function highlightText(text, matches, key) {
        if (!matches || !text) return escapeHtml(text);

        const match = matches.find(m => m.key === key);
        if (!match || !match.indices) return escapeHtml(text);

        let result = '';
        let lastIndex = 0;

        // Sort indices by start position
        const sortedIndices = match.indices.sort((a, b) => a[0] - b[0]);

        sortedIndices.forEach(([start, end]) => {
            // Add text before match
            result += escapeHtml(text.substring(lastIndex, start));

            // Add highlighted match
            result += `<mark>${escapeHtml(text.substring(start, end + 1))}</mark>`;

            lastIndex = end + 1;
        });

        // Add remaining text
        result += escapeHtml(text.substring(lastIndex));

        return result;
    }

    /**
     * Truncate text to maximum length
     */
    function truncateText(text, maxLength) {
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength).trim() + '...';
    }

    /**
     * Escape HTML to prevent XSS
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Handle keyboard navigation
     */
    function handleKeyboard(e) {
        const items = searchResults.querySelectorAll('.search-result-item');
        const activeItem = searchResults.querySelector('.search-result-item.selected');

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();

            let nextIndex = -1;
            if (activeItem) {
                const currentIndex = parseInt(activeItem.dataset.index);
                nextIndex = e.key === 'ArrowDown' ? currentIndex + 1 : currentIndex - 1;
                nextIndex = Math.max(0, Math.min(items.length - 1, nextIndex));
                activeItem.classList.remove('selected');
            } else if (e.key === 'ArrowDown') {
                nextIndex = 0;
            }

            if (nextIndex >= 0 && items[nextIndex]) {
                items[nextIndex].classList.add('selected');
                items[nextIndex].scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'Enter' && activeItem) {
            e.preventDefault();
            const link = activeItem.querySelector('.search-result-link');
            if (link) link.click();
        }
    }

    /**
     * Toggle search overlay
     */
    function toggleSearch() {
        if (searchOverlay) {
            searchOverlay.classList.toggle('hidden');
            if (!searchOverlay.classList.contains('hidden')) {
                searchInput.focus();
            }
        }
    }

    /**
     * Close search overlay
     */
    function closeSearch() {
        if (searchOverlay) {
            searchOverlay.classList.add('hidden');
            if (searchInput) {
                searchInput.value = '';
            }
            if (searchResults) {
                searchResults.innerHTML = '';
            }
        }
    }

    /**
     * Debounce function to limit execution rate
     */
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSearch);
    } else {
        initSearch();
    }

    // Expose toggle function globally
    window.toggleSearch = toggleSearch;
    window.closeSearch = closeSearch;
})();

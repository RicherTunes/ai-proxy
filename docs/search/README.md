# Search Functionality

This directory contains the search index for the AI Proxy documentation.

> **Related:**
> - [Dashboard Screenshots](../screenshots/README.md) - Visual documentation
> - [Testing Guide](../developer-guide/testing.md) - Test coverage and CI
> - [Getting Started Guide](../user-guide/getting-started.md) - Quick start documentation

## How It Works

The search functionality uses **Fuse.js**, a lightweight fuzzy search library that runs entirely in the browser. This means:

- Works offline (no server required)
- Instant results as you type
- Fuzzy matching (finds results even with typos)
- Highlights matching text
- Shows relevance scores

## Generating the Search Index

When you add or update documentation, regenerate the search index:

```bash
npm run search:index
```

This will:
1. Scan all `.md` and `.html` files in the `docs/` directory
2. Extract titles, content, categories, and tags
3. Generate `docs/search/index.json`

## Files

- `index.json` - The search index (generated automatically)
- `README.md` - This file

## Implementation

The search consists of three parts:

1. **Index Generator** (`scripts/generate-search-index.js`)
   - Crawls documentation files
   - Extracts metadata and content
   - Builds search index JSON

2. **Search UI** (in `docs/index.html` and `_layouts/default.html`)
   - Search modal overlay
   - Results display with highlighting
   - Keyboard navigation (Ctrl+K to open, Enter to select)

3. **Search Logic** (`js/search.js`)
   - Loads Fuse.js library
   - Performs fuzzy search
   - Displays ranked results with highlighting

## Usage

### For Users

- Press **Ctrl+K** (or Cmd+K on Mac) to open search
- Click the "Search" button in the header
- Type to search instantly
- Use arrow keys to navigate results
- Press Enter to open selected result
- Press Escape to close

### For Developers

When adding new documentation:

1. Create your markdown/HTML files in `docs/`
2. Run `npm run search:index` to update the search index
3. Commit both the documentation and the updated `docs/search/index.json`

## Excluded Directories

The following directories are excluded from the search index:

- `node_modules/`
- `.git/`
- `milestones/`
- `plans/`
- `screenshots/`
- `search/` (this directory)

## Customization

To adjust search behavior, edit `scripts/generate-search-index.js`:

- **Sensitivity**: Adjust the `threshold` in Fuse.js options
- **Weights**: Change importance of title vs content vs tags
- **Snippet length**: Modify the context length for search results

To adjust the UI, edit the CSS in `docs/index.html` or `_layouts/default.html`.

## Performance

The search index is typically 40-50 KB for 20+ documents, which loads instantly. Fuse.js can search through hundreds of documents in milliseconds.

## Browser Support

Works in all modern browsers that support:
- ES6 JavaScript
- Fetch API
- CSS Grid and Flexbox

## License

Same as the AI Proxy project (MIT)

---
layout: default
title: Documentation
---

# AI Proxy Documentation

Welcome to the AI Proxy documentation. This site is built with [Jekyll](https://jekyllrb.com/) and hosted on [GitHub Pages](https://pages.github.com/).

## Local Development

To test the documentation site locally:

### Prerequisites

- Ruby (version 2.5 or higher)
- Bundler: `gem install bundler`

### Build the Site

1. Install dependencies:
   ```bash
   bundle install
   ```

2. Build the site:
   ```bash
   bundle exec jekyll build
   ```

3. Serve locally (optional):
   ```bash
   bundle exec jekyll serve
   ```
   Then visit `http://localhost:4000/ai-proxy/`

### Quick Test

Run the test script:
```bash
./scripts/test-build.sh
```

## Adding New Documentation

1. Create a new markdown file in the appropriate directory under `docs/`
2. Add front matter at the top:
   ```yaml
   ---
   layout: default
   title: Your Page Title
   ---
   ```
3. Add a link to it in `docs/index.html` (without the `.md` extension)

## Link Format

- **External links in index.html**: Use directory format with trailing slash
  - Correct: `./user-guide/getting-started/`
  - Incorrect: `./user-guide/getting-started.md`

- **Internal markdown links**: Use directory format with trailing slash
  - Correct: `[Getting Started](../user-guide/getting-started/)`
  - Incorrect: `[Getting Started](../user-guide/getting-started.md)`

## Architecture

- **`_layouts/default.html`**: Main layout template with styling
- **`_config.yml`**: Jekyll configuration
- **`docs/index.html`**: Landing page with navigation
- **`docs/**/*.md`**: Documentation content with front matter

## Styling

The documentation uses a custom gradient design with:
- Purple gradient background (#667eea to #764ba2)
- White content cards
- Responsive grid layout
- Syntax highlighting for code blocks

## Deployment

The site is automatically deployed to GitHub Pages when changes are pushed to the main branch. The site is available at:
https://richtunes.github.io/ai-proxy/

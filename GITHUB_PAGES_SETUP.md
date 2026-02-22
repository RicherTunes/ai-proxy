# GitHub Pages Deployment Setup

## Overview

The documentation site is now configured to build and deploy automatically via GitHub Actions when changes are pushed to the main branch.

## What Was Created

### GitHub Actions Workflow
**File:** `.github/workflows/docs.yml`

This workflow:
1. **Triggers** on push to `main` branch when docs-related files change
2. **Builds** the Jekyll site from the repository root
3. **Deploys** to GitHub Pages using the official GitHub Actions

### Workflow Features

- **Path-based triggers**: Only runs when documentation files change
- **Manual trigger**: Can be triggered via `workflow_dispatch` in GitHub Actions UI
- **Ruby 3.3**: Uses latest stable Ruby version
- **Bundler cache**: Speeds up builds by caching dependencies
- **Official actions**: Uses `actions/jekyll-build-pages@v1` and `actions/deploy-pages@v4`

## Required Configuration Changes

### GitHub Pages Settings

You need to update the repository settings:

1. Go to repository **Settings** → **Pages**
2. Under **Build and deployment**:
   - **Source**: Select `GitHub Actions` (NOT "Deploy from a branch")
3. Click **Save**

This is critical because:
- The `/docs` source path uses "legacy" mode which doesn't run Jekyll
- Using `GitHub Actions` as source enables the workflow to build and deploy

### Permissions

The workflow includes these permissions:
```yaml
permissions:
  contents: read
  pages: write
  id-token: write
```

These are required for the Pages deployment to work.

## How It Works

### Build Job
1. Checks out the code
2. Sets up Ruby 3.3 with bundler cache
3. Builds Jekyll site from `./` to `./_site`
4. Uploads the `_site` directory as an artifact

### Deploy Job
1. Waits for build to complete
2. Deploys the artifact to GitHub Pages
3. Outputs the deployment URL

## Local Testing

Before pushing, you can test the build locally:

### Prerequisites
```bash
# Install Ruby (if not installed)
# Windows: Download from rubyinstaller.org
# macOS: brew install ruby
# Linux: sudo apt-get install ruby-full

# Install Bundler
gem install bundler
```

### Test Build
```bash
# From repository root
cd C:\Users\Alexandre\.claude-glm

# Install dependencies
bundle install

# Build the site
bundle exec jekyll build --source . --destination _site

# Or use the test script
./scripts/test-build.sh
```

### Serve Locally
```bash
bundle exec jekyll serve --source . --destination _site
# Visit http://localhost:4000/ai-proxy/
```

## Verification

After pushing to main:

1. Go to **Actions** tab in your repository
2. Click on the "Build and Deploy Documentation" workflow
3. Verify the workflow runs successfully
4. Check the deployment URL in the workflow output

The site will be available at:
```
https://richertunes.github.io/ai-proxy/
```

## Workflow Triggers

The workflow runs automatically when you push changes to:
- `_config.yml` - Jekyll configuration
- `_layouts/**` - Layout templates
- `_includes/**` - Include files
- `docs/**` - Documentation content
- `.github/workflows/docs.yml` - The workflow itself

You can also trigger it manually from the Actions tab.

## Troubleshooting

### Build Fails

1. Check the Actions tab for error logs
2. Verify YAML syntax is correct
3. Ensure all markdown files have proper front matter

### Deployment Fails

1. Verify GitHub Pages source is set to `GitHub Actions`
2. Check that workflow has necessary permissions
3. Ensure the repository is public (or has GitHub Pages enabled for private repos)

### Site Not Updating

1. Check if workflow ran in Actions tab
2. Clear browser cache
3. Verify the deployment URL in workflow output

## File Structure

```
.
├── .github/
│   └── workflows/
│       └── docs.yml          # NEW: GitHub Actions workflow
├── _config.yml               # Jekyll configuration
├── _layouts/
│   └── default.html          # Main layout template
├── Gemfile                   # Ruby dependencies
├── docs/
│   ├── index.html            # Documentation landing page
│   ├── user-guide/           # User documentation
│   ├── developer-guide/      # Developer documentation
│   └── ...
└── scripts/
    └── test-build.sh         # Local build test script
```

## Next Steps

1. Commit and push the workflow file:
   ```bash
   git add .github/workflows/docs.yml
   git commit -m "docs: add GitHub Actions workflow for Jekyll deployment"
   git push origin main
   ```

2. Update GitHub Pages settings to use `GitHub Actions` as source

3. Verify the workflow runs in the Actions tab

4. Visit your deployed site

## Related Documentation

- [GitHub Pages documentation](https://docs.github.com/en/pages)
- [GitHub Actions for Jekyll](https://github.com/actions/jekyll-build-pages)
- [Jekyll documentation](https://jekyllrb.com/docs/)

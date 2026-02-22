# GitHub Pages Configuration Checklist

## Critical Configuration Step

You MUST update the GitHub Pages settings in your repository:

### Steps:

1. Navigate to: https://github.com/richtunes/ai-proxy/settings/pages

2. Under "Build and deployment":
   - Find the **Source** section
   - Change from "Deploy from a branch" to **"GitHub Actions"**
   - Click **Save**

3. The workflow will automatically run on the next push to main

## Why This Is Required

GitHub Pages has two deployment modes:

### Mode 1: Deploy from a Branch (Legacy)
- Directly serves files from a branch (e.g., `/docs` folder)
- Does NOT run Jekyll or any build process
- Only works for static HTML files

### Mode 2: GitHub Actions (Modern)
- Runs GitHub Actions workflows to build and deploy
- Supports Jekyll, Hugo, and other static site generators
- Required for our workflow

Since our Jekyll files (`_config.yml`, `_layouts/`) are at the repo root but the documentation is in `/docs`, we need GitHub Actions to:
1. Build the Jekyll site from the repo root
2. Deploy the compiled output to GitHub Pages

## Verification

After updating the setting:

1. Push the workflow file to main
2. Go to the **Actions** tab
3. Click on "Build and Deploy Documentation"
4. Verify both jobs (build + deploy) complete successfully
5. Visit https://richtunes.github.io/ai-proxy/

## Troubleshooting

### "Page not found" error
- Verify GitHub Pages source is set to "GitHub Actions"
- Check Actions tab to see if workflow ran
- Wait 1-2 minutes for deployment to complete

### Workflow doesn't run
- Verify you're pushing to the `main` branch
- Check that changed files match the path filters
- Try triggering manually from Actions tab

### Build fails in workflow
- Check the workflow logs in the Actions tab
- Verify YAML syntax is correct
- Ensure all markdown files have proper front matter

## Quick Links

- Actions tab: https://github.com/richtunes/ai-proxy/actions
- Pages settings: https://github.com/richtunes/ai-proxy/settings/pages
- Workflow file: `.github/workflows/docs.yml`

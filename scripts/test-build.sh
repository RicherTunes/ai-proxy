#!/bin/bash

echo "=== Testing Jekyll Build ==="

# Check if bundler is installed
if ! command -v bundle &> /dev/null; then
  echo "Bundler not found. Installing..."
  gem install bundler
fi

# Install dependencies
echo "Installing Jekyll dependencies..."
bundle install

# Build the site
echo "Building site..."
bundle exec jekyll build --source . --destination _site

# Check if build was successful
if [ $? -eq 0 ]; then
  echo "✓ Build successful!"
  echo ""
  echo "Checking generated files..."

  # Check if HTML files were generated
  if [ -f "_site/index.html" ]; then
    echo "✓ _site/index.html exists"
  fi

  if [ -d "_site/user-guide" ]; then
    echo "✓ _site/user-guide/ directory exists"
    if [ -f "_site/user-guide/getting-started/index.html" ]; then
      echo "✓ _site/user-guide/getting-started/index.html exists"
    fi
  fi

  echo ""
  echo "To serve locally, run:"
  echo "  bundle exec jekyll serve --source . --destination _site"
else
  echo "✗ Build failed!"
  exit 1
fi

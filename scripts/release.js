#!/usr/bin/env node
/**
 * Manual Release Script
 *
 * Creates a git tag for manual release.
 * Usage: node scripts/release.js [patch|minor|major]
 *
 * This script is a fallback when automated releases aren't suitable.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const bumpType = process.argv[2] || 'patch';

if (!['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('Usage: node scripts/release.js [patch|minor|major]');
  process.exit(1);
}

function getCurrentVersion() {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return pkg.version;
}

function bumpVersion(version, type) {
  const parts = version.split('.').map(Number);
  if (type === 'major') {
    return `${parts[0] + 1}.0.0`;
  } else if (type === 'minor') {
    return `${parts[0]}.${parts[1] + 1}.0`;
  } else {
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
}

const currentVersion = getCurrentVersion();
const newVersion = bumpVersion(currentVersion, bumpType);

console.log(`Bumping version: ${currentVersion} -> ${newVersion}`);

// Update package.json
const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// Create tag
try {
  execSync(`git tag -a v${newVersion} -m "Release v${newVersion}"`);
  console.log(`✅ Created tag v${newVersion}`);
  console.log(`Run 'git push origin v${newVersion}' to push the tag and trigger release`);
} catch (err) {
  console.error('❌ Failed to create tag:', err.message);
  process.exit(1);
}
#!/usr/bin/env node
/**
 * Version Script
 *
 * Displays current version and version info.
 * Run: node scripts/version.js
 */

const fs = require('fs');
const path = require('path');

function readVersion() {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return pkg.version;
}

function readChangelogVersion() {
  const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return null;

  const content = fs.readFileSync(changelogPath, 'utf8');
  // Match [X.Y.Z] pattern
  const match = content.match(/\[(\d+\.\d+\.\d+(-[a-z0-9.]+)?)\]/);
  return match ? match[1] : null;
}

const pkgVersion = readVersion();
const changelogVersion = readChangelogVersion();

console.log(`Package version: ${pkgVersion}`);
if (changelogVersion) {
  console.log(`Changelog version: ${changelogVersion}`);
  if (changelogVersion !== pkgVersion) {
    console.warn('⚠️  Version mismatch detected!');
  } else {
    console.log('✅ Versions are in sync');
  }
}
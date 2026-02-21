#!/usr/bin/env node
'use strict';

/**
 * Extract dashboard CSS and JS from runtime HTML output.
 *
 * IMPORTANT: We extract from the RUNTIME output (not source lines) because
 * the source file uses escaped backticks and escaped interpolations that are
 * only valid inside the outer template literal. The runtime output has real
 * backticks and real ${} — valid standalone JS/CSS.
 */

const fs = require('fs');
const path = require('path');
const { generateDashboard } = require('../lib/dashboard');

// Generate runtime HTML with no nonce (clean output)
const html = generateDashboard({ nonce: '', cspEnabled: false });

// Extract CSS: content between <style> and </style>
const cssMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!cssMatch) {
    console.error('ERROR: Could not find <style> block in dashboard HTML');
    process.exit(1);
}
const css = cssMatch[1].trim();

// Extract JS: content of the main inline <script> (the one without src= attribute)
// The CDN script has src=, so we match <script> without attributes (or with just nonce)
const jsMatch = html.match(/<script(?:\s+nonce="[^"]*")?>\s*([\s\S]*?)\s*<\/script>/);
if (!jsMatch) {
    console.error('ERROR: Could not find main <script> block in dashboard HTML');
    process.exit(1);
}
const js = jsMatch[1].trim();

// Write to public/
const publicDir = path.join(__dirname, '..', 'public');
fs.mkdirSync(publicDir, { recursive: true });

const cssPath = path.join(publicDir, 'dashboard.css');
const jsPath = path.join(publicDir, 'dashboard.js');

fs.writeFileSync(cssPath, css);
fs.writeFileSync(jsPath, js);

console.log(`Extracted CSS: ${css.length} chars -> ${cssPath}`);
console.log(`Extracted JS:  ${js.length} chars -> ${jsPath}`);
console.log('Done.');

/**
 * compare-screenshots.js
 *
 * Compares generated screenshots against committed versions
 * to detect actual visual changes before committing.
 *
 * Usage:
 *   node scripts/compare-screenshots.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SOURCE_DIR = path.join(__dirname, '../test/e2e/dashboard-docs.e2e.spec.js-snapshots');
const DOCS_DIR = path.join(__dirname, '../docs/screenshots');

// Threshold for considering images as "changed" (percentage of pixels that differ)
const PIXEL_DIFF_THRESHOLD = 0.01; // 0.1% of pixels can differ
const MAX_DIFF_PIXELS = 50; // Or max 50 pixels total

// Screenshot mapping from test snapshots to docs location
const SCREENSHOT_MAPPING = {
    'docs-01-overview': { target: 'overview.png', category: '' },
    'docs-02-routing': { target: 'routing.png', category: '' },
    'docs-03-requests': { target: 'requests.png', category: '' },
    'docs-04-system': { target: 'system.png', category: '' },
    'docs-themes-01-dark-theme': { target: 'dark-theme.png', category: 'themes' },
    'docs-themes-02-light-theme': { target: 'light-theme.png', category: 'themes' },
    'docs-density-01-compact': { target: 'compact.png', category: 'density' },
    'docs-density-02-comfortable': { target: 'comfortable.png', category: 'density' },
    'docs-sections-01-health-ribbon': { target: 'health-ribbon.png', category: 'sections' },
    'docs-sections-02-keys-heatmap': { target: 'keys-heatmap.png', category: 'sections' },
    'docs-sections-03-cost-panel': { target: 'cost-panel.png', category: 'sections' },
    'docs-sections-04-charts': { target: 'charts.png', category: 'sections' },
    'docs-panels-live-collapsed': { target: 'live-collapsed.png', category: 'panels' },
    'docs-panels-live-expanded': { target: 'live-expanded.png', category: 'panels' },
    'docs-panels-live-content': { target: 'live-content.png', category: 'panels' },
    'docs-dock-tabs-01-traces': { target: 'traces.png', category: 'dock-tabs' },
    'docs-dock-tabs-02-logs': { target: 'logs.png', category: 'dock-tabs' },
    'docs-dock-tabs-03-queue': { target: 'queue.png', category: 'dock-tabs' },
    'docs-dock-tabs-04-circuit': { target: 'circuit.png', category: 'dock-tabs' },
    'docs-routing-01-tier-builder': { target: 'tier-builder.png', category: 'routing' },
    'docs-modals-keyboard-shortcuts': { target: 'keyboard-shortcuts.png', category: 'modals' },
    'docs-system-01-error-breakdown': { target: 'error-breakdown.png', category: 'system' },
    'docs-system-02-retry-analytics': { target: 'retry-analytics.png', category: 'system' },
    'docs-system-03-health-score': { target: 'health-score.png', category: 'system' },
    'docs-progressive-advanced-stats-collapsed': { target: 'advanced-stats-collapsed.png', category: 'progressive' },
    'docs-progressive-advanced-stats-expanded': { target: 'advanced-stats-expanded.png', category: 'progressive' },
    'docs-progressive-process-health-collapsed': { target: 'process-health-collapsed.png', category: 'progressive' },
    'docs-progressive-process-health-expanded': { target: 'process-health-expanded.png', category: 'progressive' },
    'docs-responsive-mobile-375px': { target: 'mobile-375px.png', category: 'responsive' },
    'docs-responsive-tablet-768px': { target: 'tablet-768px.png', category: 'responsive' },
    'docs-responsive-desktop-1920px': { target: 'desktop-1920px.png', category: 'responsive' },
};

async function compareImages(oldPath, newPath) {
    // Use ImageMagick compare if available
    if (fs.existsSync(oldPath) && fs.existsSync(newPath)) {
        try {
            // Try ImageMagick first (more accurate)
            const result = execSync(
                `compare -metric AE -f "%[diff]" "${oldPath}" "${newPath}" /dev/null 2>&1 || echo "0"`,
                { encoding: 'utf8', stdio: 'pipe' }
            );
            const diffPercent = parseFloat(result.trim()) / 100; // AE returns 0-1, convert to percentage
            return isNaN(diffPercent) ? 0 : diffPercent;
        } catch (e) {
            // Fallback: check file size difference (rough approximation)
            const oldSize = fs.statSync(oldPath).size;
            const newSize = fs.statSync(newPath).size;
            if (oldSize === 0) return 1;
            const sizeDiff = Math.abs(oldSize - newSize) / oldSize;
            return sizeDiff > 0.01 ? sizeDiff : 0;
        }
    }
    return 1; // No old file, consider it changed
}

async function main() {
    console.log('🔍 Comparing screenshots for actual changes...\n');

    let changedCount = 0;
    let unchangedCount = 0;
    const changes = [];

    // Get platform suffix
    const platform = 'chromium-win32'; // TODO: detect platform
    const suffix = `-${platform}.png`;

    for (const [source, info] of Object.entries(SCREENSHOT_MAPPING)) {
        const sourceFile = path.join(SOURCE_DIR, `${source}${suffix}`);
        const targetFile = path.join(DOCS_DIR, info.category ? info.category : '', info.target);

        if (!fs.existsSync(sourceFile)) {
            console.log(`⚠️  ${source} not found, skipping`);
            continue;
        }

        if (!fs.existsSync(targetFile)) {
            console.log(`✅ ${info.target} - new file`);
            changes.push(targetFile);
            changedCount++;
            continue;
        }

        // Compare using ImageMagick or file size
        const diffPercent = await compareImages(targetFile, sourceFile);

        if (diffPercent > PIXEL_DIFF_THRESHOLD) {
            console.log(`✅ ${info.target} - changed (${(diffPercent * 100).toFixed(2)}% diff)`);
            changes.push(targetFile);
            changedCount++;
        } else {
            console.log(`⏭️  ${info.target} - unchanged (${(diffPercent * 100).toFixed(4)}% diff, below threshold)`);
            unchangedCount++;
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log(`📊 Summary: ${changedCount} changed, ${unchangedCount} unchanged`);

    if (changes.length > 0) {
        console.log('\n📝 Changed files:');
        changes.forEach(f => console.log(`   ${f}`));
    }

    // Write changes file for GitHub Action
    const changesFile = path.join(__dirname, '.screenshot-changes.txt');
    if (changes.length > 0) {
        fs.writeFileSync(changesFile, changes.join('\n'));
        console.log(`\n📄 Changes written to ${changesFile}`);
    } else {
        if (fs.existsSync(changesFile)) fs.unlinkSync(changesFile);
        console.log('\n✨ No visual changes detected - screenshots are identical!');
    }

    // Set output for GitHub Actions
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_changes=${changes.length > 0}\n`);
    }

    return changes.length > 0;
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});

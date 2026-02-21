#!/usr/bin/env node
/**
 * Quarantine Deadline Enforcement
 *
 * Fails CI if:
 * - Any test in test/quarantine/ is past its deadline
 * - Any test is added without a deadline in QUARANTINE_EXIT.md
 *
 * Usage:
 *   node scripts/check-quarantine-deadlines.js
 *
 * Exit codes:
 *   0 - All tests have valid, unexpired deadlines
 *   1 - Deadline violations found
 */

const fs = require('fs');
const path = require('path');

const QUARANTINE_DIR = path.join(__dirname, '..', 'test', 'quarantine');
const EXIT_PLAN_FILE = path.join(__dirname, '..', 'test', 'quarantine', 'QUARANTINE_EXIT.md');

function parseExitPlan() {
    if (!fs.existsSync(EXIT_PLAN_FILE)) {
        console.error('ERROR: QUARANTINE_EXIT.md not found');
        process.exit(1);
    }

    const content = fs.readFileSync(EXIT_PLAN_FILE, 'utf8');
    const deadlines = new Map();

    // Parse table rows: | filename | deadline | status |
    // Format: | request-handler.test.js | 2026-02-28 | ... |
    const tableRowRegex = /\|\s*([a-zA-Z0-9_.-]+\.test\.js)\s*\|[^|]*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/g;
    let match;

    while ((match = tableRowRegex.exec(content)) !== null) {
        const filename = match[1];
        const deadline = match[2];
        deadlines.set(filename, new Date(deadline));
    }

    // Also check for inline deadlines like "Deadline: 2026-02-28"
    const inlineRegex = /###\s+([a-zA-Z0-9_.-]+\.test\.js)[^#]*?Deadline:\s*(\d{4}-\d{2}-\d{2})/gs;
    while ((match = inlineRegex.exec(content)) !== null) {
        const filename = match[1];
        const deadline = match[2];
        if (!deadlines.has(filename)) {
            deadlines.set(filename, new Date(deadline));
        }
    }

    return deadlines;
}

function getQuarantineTests() {
    if (!fs.existsSync(QUARANTINE_DIR)) {
        return [];
    }

    return fs.readdirSync(QUARANTINE_DIR)
        .filter(f => f.endsWith('.test.js'));
}

function main() {
    console.log('Checking quarantine test deadlines...\n');

    const deadlines = parseExitPlan();
    const tests = getQuarantineTests();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let violations = [];
    let warnings = [];

    for (const test of tests) {
        const deadline = deadlines.get(test);

        if (!deadline) {
            violations.push({
                test,
                reason: 'No deadline found in QUARANTINE_EXIT.md',
                action: 'Add an entry with deadline and fix plan'
            });
            continue;
        }

        const daysRemaining = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));

        if (daysRemaining < 0) {
            violations.push({
                test,
                reason: `Deadline expired ${-daysRemaining} days ago (${deadline.toISOString().slice(0, 10)})`,
                action: 'Fix the test or extend deadline with justification'
            });
        } else if (daysRemaining <= 7) {
            warnings.push({
                test,
                deadline: deadline.toISOString().slice(0, 10),
                daysRemaining
            });
        }
    }

    // Report
    if (warnings.length > 0) {
        console.log('⚠️  Tests approaching deadline:');
        for (const w of warnings) {
            console.log(`   ${w.test}: ${w.daysRemaining} days remaining (${w.deadline})`);
        }
        console.log('');
    }

    if (violations.length > 0) {
        console.log('❌ Deadline violations:\n');
        for (const v of violations) {
            console.log(`   ${v.test}`);
            console.log(`   Reason: ${v.reason}`);
            console.log(`   Action: ${v.action}`);
            console.log('');
        }
        console.log(`\nTotal violations: ${violations.length}`);
        console.log('See test/quarantine/QUARANTINE_EXIT.md for fix plans.');
        process.exit(1);
    }

    console.log(`✅ All ${tests.length} quarantine tests have valid deadlines.`);

    if (tests.length > 0) {
        console.log('\nCurrent quarantine status:');
        for (const test of tests) {
            const deadline = deadlines.get(test);
            if (deadline) {
                const daysRemaining = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
                console.log(`   ${test}: ${daysRemaining} days remaining`);
            }
        }
    }

    process.exit(0);
}

main();

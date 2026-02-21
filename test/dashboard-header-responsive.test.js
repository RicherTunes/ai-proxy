'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { generateDashboard } = require('../lib/dashboard');

describe('Header responsive contracts', () => {
    const rootDir = path.join(__dirname, '..');
    let layoutCss;
    let initSource;
    let html;

    beforeAll(() => {
        layoutCss = fs.readFileSync(path.join(rootDir, 'public', 'css', 'layout.css'), 'utf8');
        initSource = fs.readFileSync(path.join(rootDir, 'public', 'js', 'init.js'), 'utf8');
        html = generateDashboard({ nonce: '', cspEnabled: false });
    });

    test('header markup exposes primary responsive control points', () => {
        const doc = new JSDOM(html).window.document;
        expect(doc.querySelector('.sticky-header')).not.toBeNull();
        expect(doc.getElementById('headerToolbarPromoted')).not.toBeNull();
        expect(doc.getElementById('overflowMenuContainer')).not.toBeNull();
        expect(doc.getElementById('globalSearchContainer')).not.toBeNull();
        expect(doc.getElementById('timeRangeSelector')).not.toBeNull();
    });

    test('layout has explicit laptop breakpoint hardening (1024-1279)', () => {
        expect(layoutCss).toMatch(/@media\s*\(min-width:\s*1024px\)\s*and\s*\(max-width:\s*1279px\)/);
        expect(layoutCss).toMatch(/@media[\s\S]*?max-width:\s*1279px[\s\S]*?\.sticky-header\s*\{[\s\S]*?flex-wrap:\s*wrap/);
    });

    test('HeaderResponsive includes adaptive overflow compaction classes', () => {
        expect(initSource).toMatch(/is-cramped/);
        expect(initSource).toMatch(/is-tight/);
        expect(initSource).toMatch(/is-ultra-tight/);
    });
});

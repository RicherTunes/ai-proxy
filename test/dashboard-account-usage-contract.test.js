'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { generateDashboard } = require('../lib/dashboard');

describe('Dashboard account usage UI contract', () => {
    test('account usage panel includes status message container', () => {
        const html = generateDashboard({ nonce: '', cspEnabled: false });
        const doc = new JSDOM(html).window.document;
        const statusEl = doc.getElementById('acctUsageStatus');
        expect(statusEl).not.toBeNull();
        expect(statusEl.classList.contains('account-usage-status')).toBe(true);
    });

    test('data module handles sourceUnavailable in header pill state', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'data.js'), 'utf8');
        expect(source).toMatch(/if\s*\(au\.sourceUnavailable\)/);
        expect(source).toMatch(/pill\.classList\.add\('danger'\)/);
        expect(source).toMatch(/source unavailable/);
    });

    test('data module escalates stale\/partial account usage to warning state', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'data.js'), 'utf8');
        expect(source).toMatch(/if\s*\(au\.partial\s*&&\s*level\s*!==\s*'danger'\)\s*level\s*=\s*'warning'/);
        expect(source).toMatch(/if\s*\(au\.stale\s*&&\s*level\s*===\s*'ok'\)\s*level\s*=\s*'warning'/);
    });

    test('data module renders explicit panel status for sourceUnavailable\/partial\/stale', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'data.js'), 'utf8');
        expect(source).toMatch(/acctUsageStatus/);
        expect(source).toMatch(/Usage source unavailable/);
        expect(source).toMatch(/Partial usage data/);
        expect(source).toMatch(/Usage data is stale/);
    });
});

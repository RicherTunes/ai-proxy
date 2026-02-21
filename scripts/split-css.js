#!/usr/bin/env node
/**
 * CSS Splitter — Phase 5
 * Splits public/dashboard.css into 8 modular CSS files in public/css/
 * Preserves exact declaration order (CSS cascade).
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'public', 'dashboard.css');
const OUT = path.join(__dirname, '..', 'public', 'css');

const lines = fs.readFileSync(SRC, 'utf8').split('\n');

// Line ranges are 1-indexed (matching the file read output)
// Each module is an array of [startLine, endLine] pairs (inclusive, 1-indexed)
const modules = {
  'tokens.css': [
    [1, 135]  // :root, [data-theme="light"], *, body, density classes
  ],
  'layout.css': [
    [136, 511],  // === LAYOUT SYSTEM, sticky header, alert bar, side panel, bottom drawer, accessibility, page nav, header
    [5975, 6117],  // Phase 4b: navigation flattening, Phase 4c: requests page sub-tabs
  ],
  'components.css': [
    [512, 716],   // Control buttons, standardized buttons, status cards, cards, density toggle, tenant selector
    [1405, 1762],  // Connection status, auth badge, admin controls, toasts, modals, shortcuts, kbd, theme toggle, fullscreen, sparkline, animated number, percentile cards, analytics table, token panel
    [3136, 3367],  // Quick actions, visual alert borders, flash animation, key override modal, modal header/footer, override count badge
    [4485, 5075],  // UX improvements: filters, keyboard shortcuts, context menu, collapsible sections, typography, pulse, heartbeat, status badges, tier badges, visually hidden, global search, anomaly detection, shareable URLs, request details comparison
  ],
  'health.css': [
    [717, 1111],   // Health ribbon, health items, health score badge/bar, key chips (with health scores), circuit states, slow key indicator
    [1112, 1366],  // Connection health card, health metrics, score distribution, key details, info row, queue progress, logs section
    [2953, 3135],  // Active issues panel, issues badge in health ribbon
  ],
  'requests.css': [
    [1367, 1404],  // ========== NEW FEATURES STYLES ========== / Time range selector (partial)
    [1763, 2315],  // Token panel (end), circuit timeline, live request stream, request rows, routing chips, config badges, stream toolbar, filters, btn-icon, stream footer, keyboard hint, ordering indicators, request hover/selection, copy button, retry timeline, compact mode, narrow/mobile, export button, responsive (768/480)
    [2521, 2600],  // Request trace table, shared status indicator, tenant selector (repeat), insights
    [2757, 2952],  // Tabbed details, tab nav/btn/content/panel, traces table, trace timeline visualization, trace attempt cards, filter input, circuit timeline
    [5843, 5957],  // Phase 2 inline style extraction: section divider, routing subsection titles, trace stat label, section title sm, trace detail panel, obs status bar, trace stats bar, request table, rule builder row, form labels, override inputs
  ],
  'routing.css': [
    [3368, 4484],  // Routing observability panel, routing tabs, explain result, tables, model routing panel, routing status, fallback chains, model pools, tier edit inputs, === TIER BUILDER ===, upgrade info panel, models bank, tier lanes, model cards, SortableJS drag, responsive, routing test form, collapsible, section subtitle, live flow visualization, swim lanes, flow particles, reduced motion, info panel
    [5237, 5251],  // Status pill for routing
  ],
  'charts.css': [
    [2316, 2520],  // ========== NEW FEATURE STYLES (#3-#10) ==========: prediction badge, cost panel, latency histogram, comparison panel
    [2601, 2756],  // ========== PHASE 2: HEATMAP & TABS ==========: keys heatmap, heatmap cells, heatmap tooltip
  ],
  'utilities.css': [
    [5076, 5236],  // KPI strip grid layout, KPI secondary, KPI subtext, alert bar hidden, overflow menu, responsive sticky header, chart empty state, chart-card position
    [5252, 5842],  // blank line + === PHASE 6: hover states & accessibility ===, === SYSTEMIC RESPONSIVE BREAKPOINTS ===, thin scrollbars, === UTILITY CLASSES ===, unified state styles, skeleton loading
    [5958, 5974],  // SVG icon system
  ],
};

// Verify no line is assigned to multiple modules and no line is missed
const assigned = new Set();
let totalAssigned = 0;
for (const [modName, ranges] of Object.entries(modules)) {
  for (const [start, end] of ranges) {
    for (let i = start; i <= end; i++) {
      if (assigned.has(i)) {
        console.error(`ERROR: Line ${i} assigned to multiple modules (found in ${modName})`);
        process.exit(1);
      }
      assigned.add(i);
      totalAssigned++;
    }
  }
}

const totalLines = lines.length;
const unassigned = [];
for (let i = 1; i <= totalLines; i++) {
  if (!assigned.has(i)) {
    unassigned.push(i);
  }
}

if (unassigned.length > 0) {
  // Group consecutive unassigned lines for readability
  const groups = [];
  let start = unassigned[0], end = unassigned[0];
  for (let i = 1; i < unassigned.length; i++) {
    if (unassigned[i] === end + 1) {
      end = unassigned[i];
    } else {
      groups.push([start, end]);
      start = unassigned[i];
      end = unassigned[i];
    }
  }
  groups.push([start, end]);
  console.warn(`WARNING: ${unassigned.length} unassigned lines:`);
  for (const [s, e] of groups) {
    const preview = lines[s - 1].trim().substring(0, 60);
    console.warn(`  Lines ${s}-${e}: "${preview}..."`);
  }
}

console.log(`Total lines: ${totalLines}`);
console.log(`Assigned lines: ${totalAssigned}`);
console.log(`Unassigned lines: ${unassigned.length}`);

// Write module files
fs.mkdirSync(OUT, { recursive: true });

for (const [modName, ranges] of Object.entries(modules)) {
  const parts = [];
  for (const [start, end] of ranges) {
    // lines array is 0-indexed, line numbers are 1-indexed
    const chunk = lines.slice(start - 1, end);
    parts.push(chunk.join('\n'));
  }
  const content = parts.join('\n\n');
  const outPath = path.join(OUT, modName);
  fs.writeFileSync(outPath, content, 'utf8');

  const lineCount = content.split('\n').length;
  console.log(`  ${modName}: ${lineCount} lines`);
}

console.log('\nCSS split complete!');

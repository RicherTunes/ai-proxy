# Vendor Directory

This directory contains fallback copies of CDN-hosted dependencies for the dashboard.

## Purpose

These files serve as local fallbacks when CDN is unavailable. The dashboard implements automatic fallback - if CDN loads fail, these local copies are loaded instead.

## Files

- `chart.js.min.js` - Chart.js (from https://cdn.jsdelivr.net/npm/chart.js/dist/chart.umd.js)
- `d3.min.js` - D3.js v7 (from https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js)
- `sortable.min.js` - SortableJS 1.15.6 (from https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js)

## Maintenance

When updating CDN versions in `lib/dashboard.js`, update these files to match:

```bash
# Download matching versions
curl -o chart.js.min.js https://cdn.jsdelivr.net/npm/chart.js/dist/chart.umd.js
curl -o d3.min.js https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js
curl -o sortable.min.js https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js
```

## Licenses

Each library retains its original license. See library websites for license details:
- Chart.js: MIT license
- D3.js: BSD 3-Clause license
- SortableJS: MIT license

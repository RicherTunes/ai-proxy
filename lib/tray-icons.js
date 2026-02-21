'use strict';

// Base64 encoded 16x16 ICO icons
// These are simple colored circle icons

const ICONS = {
    // Green icon - healthy state
    green: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABfSURBVDiNY2AYBcMBMDIw/P/PwMDAwMrKymBsbMzAwMDA8P//fwYGBgaG////M/z//5+BgYGB4f///wyOjo4MDAwMDP///2dgYGBg+P//PwMDAwODo6MjAwMDw38GBqoAAGlXFQX1JLlFAAAAAElFTkSuQmCC',

    // Yellow icon - warning state (some keys in HALF_OPEN)
    yellow: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABfSURBVDiNY2AYBcMBMDIw/P/PwMDAkJyczGBsbMzAwMDA8P//fwYGBgaG////M/z//5+BgYGB4f///wyJiYkMDAwMDP///2dgYGBg+P//PwMDAwNDYmIiAwMDw38GBqoAAGoPFQVVhC5fAAAAAElFTkSuQmCC',

    // Red icon - error state (keys in OPEN or proxy paused)
    red: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABfSURBVDiNY2AYBcMBMDIw/P/PwMDA4OzszGBsbMzAwMDA8P//fwYGBgaG////M/z//5+BgYGB4f///wzOzs4MDAwMDP///2dgYGBg+P//PwMDAwODs7MzAwMDw38GBqoAAHIzFQX5+8fXAAAAAElFTkSuQmCC',

    // Gray icon - offline/unknown state
    gray: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABfSURBVDiNY2AYBcMBMDIw/P/PwMDAkJKSwmBsbMzAwMDA8P//fwYGBgaG////M/z//5+BgYGB4f///wwpKSkMDAwMDP///2dgYGBg+P//PwMDAwNDSkoKAwMDw38GBqoAAGzrFQVb8x9bAAAAAElFTkSuQmCC'
};

/**
 * Get the appropriate icon based on proxy health status
 * @param {Object} stats - Stats object from /stats endpoint
 * @returns {string} Base64 icon data
 */
function getIconForStatus(stats) {
    if (!stats) return ICONS.gray;

    // Check if paused
    if (stats.isPaused) return ICONS.red;

    // Check circuit states
    const keys = stats.keys || [];
    const openCount = keys.filter(k => k.circuitState === 'OPEN').length;
    const halfOpenCount = keys.filter(k => k.circuitState === 'HALF_OPEN').length;

    if (openCount > 0) return ICONS.red;
    if (halfOpenCount > 0) return ICONS.yellow;

    return ICONS.green;
}

/**
 * Get status text for tooltip
 * @param {Object} stats - Stats object
 * @returns {string} Status text
 */
function getStatusText(stats) {
    if (!stats) return 'GLM Proxy (Unknown)';
    if (stats.isPaused) return 'GLM Proxy (PAUSED)';

    const keys = stats.keys || [];
    const openCount = keys.filter(k => k.circuitState === 'OPEN').length;
    const halfOpenCount = keys.filter(k => k.circuitState === 'HALF_OPEN').length;

    if (openCount > 0) return `GLM Proxy (${openCount} keys OPEN)`;
    if (halfOpenCount > 0) return `GLM Proxy (${halfOpenCount} keys HALF_OPEN)`;

    const reqMin = stats.requestsPerMinute?.toFixed(1) || '0';
    return `GLM Proxy - ${reqMin} req/min`;
}

module.exports = { ICONS, getIconForStatus, getStatusText };

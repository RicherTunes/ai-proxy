/**
 * Counters Controller
 * Provides schema documentation for all counters
 */

'use strict';

const { COUNTER_SCHEMA } = require('../../schemas/counters');

class CountersController {
    /**
     * Get counter schema
     * @param {Object} req
     * @param {Object} res
     */
    getSchema(req, res) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({
            version: '1.0',
            timestamp: Date.now(),
            counters: COUNTER_SCHEMA
        }, null, 2));
    }
}

module.exports = { CountersController };

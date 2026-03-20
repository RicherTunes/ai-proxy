/**
 * Error Response Consistency Tests
 *
 * TDD-driven tests to ensure all controller error responses:
 * 1. Use JSON format with { error: ... } structure
 * 2. Include Cache-Control: no-store header
 * 3. Use a centralized _sendError helper (or delegate through _sendJson)
 * 4. Include Content-Type: application/json header
 *
 * Scope: lib/proxy/controllers/ only (not proxy-server.js)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CONTROLLERS_DIR = path.join(__dirname, '..', 'lib', 'proxy', 'controllers');
const RESPONSE_HELPERS_PATH = path.join(CONTROLLERS_DIR, 'response-helpers.js');

// Read the shared response-helpers module
const responseHelpersContent = fs.existsSync(RESPONSE_HELPERS_PATH)
    ? fs.readFileSync(RESPONSE_HELPERS_PATH, 'utf8')
    : null;

// Read all controller files (exclude response-helpers.js itself)
const controllerFiles = fs.readdirSync(CONTROLLERS_DIR)
    .filter(f => f.endsWith('.js') && f !== 'response-helpers.js')
    .map(f => ({
        name: f,
        path: path.join(CONTROLLERS_DIR, f),
        content: fs.readFileSync(path.join(CONTROLLERS_DIR, f), 'utf8')
    }));

/**
 * Extract all error response sites from controller source.
 * An "error response site" is any place where res.writeHead is called
 * with a 4xx or 5xx status code.
 */
function findErrorResponseSites(content, filename) {
    const sites = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Pattern 1: res.writeHead(4xx or 5xx, ...)
        const writeHeadMatch = line.match(/res\.writeHead\s*\(\s*(4\d{2}|5\d{2})/);
        if (writeHeadMatch) {
            const status = parseInt(writeHeadMatch[1], 10);

            // Gather context: next few lines to find res.end
            const contextLines = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');

            sites.push({
                file: filename,
                line: i + 1,
                status,
                code: contextLines,
                rawLine: line
            });
        }

        // Pattern 2: this._sendError(res, 4xx/5xx, ...)
        const sendErrorMatch = line.match(/this\._sendError\s*\(\s*res\s*,\s*(4\d{2}|5\d{2})/);
        if (sendErrorMatch) {
            sites.push({
                file: filename,
                line: i + 1,
                status: parseInt(sendErrorMatch[1], 10),
                code: line,
                rawLine: line,
                usesSendError: true
            });
        }

        // Pattern 3: this._sendJson(res, 4xx/5xx, ...)
        const sendJsonMatch = line.match(/this\._sendJson\s*\(\s*res\s*,\s*(4\d{2}|5\d{2})/);
        if (sendJsonMatch) {
            sites.push({
                file: filename,
                line: i + 1,
                status: parseInt(sendJsonMatch[1], 10),
                code: line,
                rawLine: line,
                usesSendJson: true
            });
        }

        // Pattern 4: sendError(res, 4xx/5xx, ...) — imported module-level function
        const importedSendErrorMatch = line.match(/(?<!\.)(?<!_)sendError\s*\(\s*res\s*,\s*(4\d{2}|5\d{2})/);
        if (importedSendErrorMatch && !line.includes('this._sendError') && !line.includes('this.sendError')) {
            sites.push({
                file: filename,
                line: i + 1,
                status: parseInt(importedSendErrorMatch[1], 10),
                code: line,
                rawLine: line,
                usesImportedSendError: true
            });
        }

        // Pattern 5: sendJson(res, 4xx/5xx, ...) — imported module-level function
        const importedSendJsonMatch = line.match(/(?<!\.)(?<!_)sendJson\s*\(\s*res\s*,\s*(4\d{2}|5\d{2})/);
        if (importedSendJsonMatch && !line.includes('this._sendJson') && !line.includes('this.sendJson')) {
            sites.push({
                file: filename,
                line: i + 1,
                status: parseInt(importedSendJsonMatch[1], 10),
                code: line,
                rawLine: line,
                usesImportedSendJson: true
            });
        }
    }

    return sites;
}

/**
 * Check if a _sendError method includes cache-control: no-store
 */
function getSendErrorImplementation(content) {
    // Find _sendError method body
    const match = content.match(/_sendError\s*\([^)]*\)\s*\{([\s\S]*?)^\s{4}\}/m);
    if (!match) return null;
    return match[1];
}

/**
 * Check if a _sendJson method includes cache-control: no-store
 */
function getSendJsonImplementation(content) {
    const match = content.match(/_sendJson\s*\([^)]*\)\s*\{([\s\S]*?)^\s{4}\}/m);
    if (!match) return null;
    return match[1];
}

/**
 * Check if a controller imports from response-helpers.js
 */
function importsResponseHelpers(content) {
    return content.includes('response-helpers');
}

/**
 * Check if a method body delegates to the imported sendError function
 * (not this._sendError, but the module-level sendError from response-helpers)
 */
function delegatesToImportedSendError(impl) {
    // matches sendError( but not this._sendError( or this.sendError(
    return /(?<!\.)sendError\s*\(/.test(impl);
}

/**
 * Check if a method body delegates to the imported sendJson function
 * (not this._sendJson, but the module-level sendJson from response-helpers)
 */
function delegatesToImportedSendJson(impl) {
    return /(?<!\.)sendJson\s*\(/.test(impl);
}

/**
 * Verify that the shared response-helpers module provides the required guarantees
 */
function responseHelpersSendErrorHasGuarantee(property) {
    if (!responseHelpersContent) return false;
    return responseHelpersContent.includes(property);
}

describe('Error Response Consistency', () => {
    // Collect all error sites across all controllers
    const allErrorSites = [];
    for (const file of controllerFiles) {
        const sites = findErrorResponseSites(file.content, file.name);
        allErrorSites.push(...sites);
    }

    describe('Test 1: All controller error responses use JSON format', () => {
        for (const file of controllerFiles) {
            const sites = findErrorResponseSites(file.content, file.name);
            const inlineSites = sites.filter(s =>
                !s.usesSendError && !s.usesSendJson &&
                !s.usesImportedSendError && !s.usesImportedSendJson
            );

            if (inlineSites.length === 0 && sites.length === 0) continue;

            describe(file.name, () => {
                for (const site of inlineSites) {
                    it(`line ${site.line}: status ${site.status} response should use JSON.stringify({ error: ... }) format`, () => {
                        // Inline writeHead+end must have JSON.stringify with error key
                        const hasJsonStringify = site.code.includes('JSON.stringify');
                        const hasErrorKey = site.code.includes('error');
                        expect(hasJsonStringify).toBe(true);
                        expect(hasErrorKey).toBe(true);
                    });
                }

                // For sites using imported sendError/sendJson, verify response-helpers has the guarantees
                const importedSites = sites.filter(s => s.usesImportedSendError || s.usesImportedSendJson);
                if (importedSites.length > 0) {
                    it('imported sendError/sendJson from response-helpers produces JSON { error: ... } format', () => {
                        expect(importsResponseHelpers(file.content)).toBe(true);
                        expect(responseHelpersSendErrorHasGuarantee('JSON.stringify')).toBe(true);
                        expect(responseHelpersSendErrorHasGuarantee('error')).toBe(true);
                    });
                }

                // For sites using _sendError, verify the helper produces correct format
                const sendErrorSites = sites.filter(s => s.usesSendError);
                if (sendErrorSites.length > 0) {
                    it('_sendError method produces JSON { error: ... } format', () => {
                        const impl = getSendErrorImplementation(file.content);
                        expect(impl).not.toBeNull();
                        // Must use JSON.stringify with error key, delegate to _sendJson,
                        // or delegate to imported sendError/sendJson from response-helpers
                        const producesJson = impl.includes('JSON.stringify') && impl.includes('error');
                        const delegatesToSendJson = impl.includes('_sendJson');
                        const delegatesToImported = delegatesToImportedSendError(impl) || delegatesToImportedSendJson(impl);
                        const importedHelperValid = delegatesToImported &&
                            importsResponseHelpers(file.content) &&
                            responseHelpersSendErrorHasGuarantee('JSON.stringify');
                        expect(producesJson || delegatesToSendJson || importedHelperValid).toBe(true);
                    });
                }

                // For sites using _sendJson with error status, verify it produces JSON
                const sendJsonSites = sites.filter(s => s.usesSendJson);
                if (sendJsonSites.length > 0) {
                    it('_sendJson method produces JSON format', () => {
                        const impl = getSendJsonImplementation(file.content);
                        expect(impl).not.toBeNull();
                        const directJson = impl.includes('JSON.stringify');
                        const delegatesToImported = delegatesToImportedSendJson(impl);
                        const importedHelperValid = delegatesToImported &&
                            importsResponseHelpers(file.content) &&
                            responseHelpersSendErrorHasGuarantee('JSON.stringify');
                        expect(directJson || importedHelperValid).toBe(true);
                    });
                }
            });
        }
    });

    describe('Test 2: All error responses include Cache-Control: no-store', () => {
        for (const file of controllerFiles) {
            const sites = findErrorResponseSites(file.content, file.name);
            if (sites.length === 0) continue;

            describe(file.name, () => {
                // Check inline error sites (truly inline, not using any helper)
                const inlineSites = sites.filter(s =>
                    !s.usesSendError && !s.usesSendJson &&
                    !s.usesImportedSendError && !s.usesImportedSendJson
                );
                for (const site of inlineSites) {
                    it(`line ${site.line}: status ${site.status} writeHead should include cache-control: no-store`, () => {
                        const hasCacheControl = site.code.includes('cache-control') && site.code.includes('no-store');
                        expect(hasCacheControl).toBe(true);
                    });
                }

                // Check _sendError helper includes cache-control
                const sendErrorSites = sites.filter(s => s.usesSendError);
                if (sendErrorSites.length > 0) {
                    it('_sendError includes cache-control: no-store', () => {
                        const impl = getSendErrorImplementation(file.content);
                        expect(impl).not.toBeNull();
                        // Either directly includes cache-control, delegates to _sendJson which includes it,
                        // or delegates to imported sendError/sendJson from response-helpers
                        const directCacheControl = impl.includes('cache-control') && impl.includes('no-store');
                        const delegatesToSendJson = impl.includes('_sendJson');
                        const delegatesToImported = delegatesToImportedSendError(impl) || delegatesToImportedSendJson(impl);
                        const importedHelperValid = delegatesToImported &&
                            importsResponseHelpers(file.content) &&
                            responseHelpersSendErrorHasGuarantee('cache-control') &&
                            responseHelpersSendErrorHasGuarantee('no-store');
                        if (delegatesToSendJson) {
                            const sendJsonImpl = getSendJsonImplementation(file.content);
                            expect(sendJsonImpl).not.toBeNull();
                            const sendJsonHasCacheControl = sendJsonImpl.includes('cache-control') && sendJsonImpl.includes('no-store');
                            const sendJsonDelegatesToImported = delegatesToImportedSendJson(sendJsonImpl);
                            const sendJsonImportedValid = sendJsonDelegatesToImported &&
                                importsResponseHelpers(file.content) &&
                                responseHelpersSendErrorHasGuarantee('cache-control') &&
                                responseHelpersSendErrorHasGuarantee('no-store');
                            expect(sendJsonHasCacheControl || sendJsonImportedValid).toBe(true);
                        } else {
                            expect(directCacheControl || importedHelperValid).toBe(true);
                        }
                    });
                }

                // Check _sendJson helper includes cache-control when used for errors
                const sendJsonSites = sites.filter(s => s.usesSendJson);
                if (sendJsonSites.length > 0) {
                    it('_sendJson includes cache-control: no-store', () => {
                        const impl = getSendJsonImplementation(file.content);
                        expect(impl).not.toBeNull();
                        const hasCacheControl = impl.includes('cache-control') && impl.includes('no-store');
                        const delegatesToImported = delegatesToImportedSendJson(impl);
                        const importedHelperValid = delegatesToImported &&
                            importsResponseHelpers(file.content) &&
                            responseHelpersSendErrorHasGuarantee('cache-control') &&
                            responseHelpersSendErrorHasGuarantee('no-store');
                        expect(hasCacheControl || importedHelperValid).toBe(true);
                    });
                }

                // Check imported sendError/sendJson sites are backed by response-helpers
                const importedErrorSites = sites.filter(s => s.usesImportedSendError);
                const importedJsonSites = sites.filter(s => s.usesImportedSendJson);
                if (importedErrorSites.length > 0 || importedJsonSites.length > 0) {
                    it('imported sendError/sendJson from response-helpers includes cache-control: no-store', () => {
                        expect(importsResponseHelpers(file.content)).toBe(true);
                        expect(responseHelpersSendErrorHasGuarantee('cache-control')).toBe(true);
                        expect(responseHelpersSendErrorHasGuarantee('no-store')).toBe(true);
                    });
                }
            });
        }
    });

    describe('Test 3: Centralized error helper exists and is used', () => {
        for (const file of controllerFiles) {
            const sites = findErrorResponseSites(file.content, file.name);
            if (sites.length === 0) continue;

            it(`${file.name}: all error responses should use _sendError, _sendJson, or imported helper (no inline writeHead for errors)`, () => {
                const inlineSites = sites.filter(s =>
                    !s.usesSendError && !s.usesSendJson &&
                    !s.usesImportedSendError && !s.usesImportedSendJson
                );
                if (inlineSites.length > 0) {
                    const details = inlineSites.map(s =>
                        `  line ${s.line}: status ${s.status}`
                    ).join('\n');
                    fail(`Found ${inlineSites.length} inline error response(s) not using a helper:\n${details}`);
                }
            });
        }
    });

    describe('Test 4: Error responses always have Content-Type: application/json', () => {
        for (const file of controllerFiles) {
            const sites = findErrorResponseSites(file.content, file.name);
            if (sites.length === 0) continue;

            describe(file.name, () => {
                // Check inline error sites (truly inline, not using any helper)
                const inlineSites = sites.filter(s =>
                    !s.usesSendError && !s.usesSendJson &&
                    !s.usesImportedSendError && !s.usesImportedSendJson
                );
                for (const site of inlineSites) {
                    it(`line ${site.line}: status ${site.status} should have Content-Type: application/json`, () => {
                        const hasContentType = site.code.includes('application/json');
                        expect(hasContentType).toBe(true);
                    });
                }

                // Check _sendError helper
                const sendErrorSites = sites.filter(s => s.usesSendError);
                if (sendErrorSites.length > 0) {
                    it('_sendError sets Content-Type: application/json', () => {
                        const impl = getSendErrorImplementation(file.content);
                        expect(impl).not.toBeNull();
                        const direct = impl.includes('application/json');
                        const delegatesToSendJson = impl.includes('_sendJson');
                        const delegatesToImported = delegatesToImportedSendError(impl) || delegatesToImportedSendJson(impl);
                        const importedHelperValid = delegatesToImported &&
                            importsResponseHelpers(file.content) &&
                            responseHelpersSendErrorHasGuarantee('application/json');
                        if (delegatesToSendJson) {
                            const sendJsonImpl = getSendJsonImplementation(file.content);
                            expect(sendJsonImpl).not.toBeNull();
                            const sendJsonDirect = sendJsonImpl.includes('application/json');
                            const sendJsonDelegatesToImported = delegatesToImportedSendJson(sendJsonImpl);
                            const sendJsonImportedValid = sendJsonDelegatesToImported &&
                                importsResponseHelpers(file.content) &&
                                responseHelpersSendErrorHasGuarantee('application/json');
                            expect(sendJsonDirect || sendJsonImportedValid).toBe(true);
                        } else {
                            expect(direct || importedHelperValid).toBe(true);
                        }
                    });
                }

                // Check _sendJson helper
                const sendJsonSites = sites.filter(s => s.usesSendJson);
                if (sendJsonSites.length > 0) {
                    it('_sendJson sets Content-Type: application/json', () => {
                        const impl = getSendJsonImplementation(file.content);
                        expect(impl).not.toBeNull();
                        const direct = impl.includes('application/json');
                        const delegatesToImported = delegatesToImportedSendJson(impl);
                        const importedHelperValid = delegatesToImported &&
                            importsResponseHelpers(file.content) &&
                            responseHelpersSendErrorHasGuarantee('application/json');
                        expect(direct || importedHelperValid).toBe(true);
                    });
                }

                // Check imported sendError/sendJson sites are backed by response-helpers
                const importedErrorSites = sites.filter(s => s.usesImportedSendError);
                const importedJsonSites = sites.filter(s => s.usesImportedSendJson);
                if (importedErrorSites.length > 0 || importedJsonSites.length > 0) {
                    it('imported sendError/sendJson from response-helpers sets Content-Type: application/json', () => {
                        expect(importsResponseHelpers(file.content)).toBe(true);
                        expect(responseHelpersSendErrorHasGuarantee('application/json')).toBe(true);
                    });
                }
            });
        }
    });
});

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Windows-safe atomic file write with fallback strategies.
 *
 * On Unix, rename() is atomic even when destination exists.
 * On Windows, rename() may fail with EPERM/EACCES when destination exists.
 * This function handles both cases.
 *
 * @param {string} filePath - Target file path
 * @param {string|Buffer} data - Content to write
 * @param {Object} options - { encoding: 'utf8', mode: 0o644 }
 * @returns {Promise<void>}
 */
async function atomicWrite(filePath, data, options = {}) {
    const { encoding = 'utf8', mode = 0o644 } = options;
    const dir = path.dirname(filePath);
    const tmpFile = path.join(dir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);

    // Ensure directory exists
    await fs.promises.mkdir(dir, { recursive: true });

    try {
        // 1. Write to temp file
        await fs.promises.writeFile(tmpFile, data, { encoding, mode });

        // 2. Try atomic rename (works on Unix, may fail on Windows if dest exists)
        try {
            await fs.promises.rename(tmpFile, filePath);
            return;
        } catch (renameErr) {
            // Only catch Windows-specific errors
            if (renameErr.code !== 'EPERM' && renameErr.code !== 'EACCES') {
                throw renameErr;
            }
            // Fall through to Windows workaround
        }

        // 3. Windows fallback: unlink existing file, then rename
        try {
            await fs.promises.unlink(filePath);
        } catch (unlinkErr) {
            // Ignore if file doesn't exist
            if (unlinkErr.code !== 'ENOENT') {
                throw unlinkErr;
            }
        }
        await fs.promises.rename(tmpFile, filePath);

    } catch (err) {
        // Clean up temp file on any error
        try {
            await fs.promises.unlink(tmpFile);
        } catch {
            // Ignore cleanup errors
        }
        throw err;
    }
}

/**
 * Synchronous version of atomicWrite.
 * Use async version when possible for better performance.
 *
 * @param {string} filePath - Target file path
 * @param {string|Buffer} data - Content to write
 * @param {Object} options - { encoding: 'utf8', mode: 0o644 }
 */
function atomicWriteSync(filePath, data, options = {}) {
    const { encoding = 'utf8', mode = 0o644 } = options;
    const dir = path.dirname(filePath);
    const tmpFile = path.join(dir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);

    // Ensure directory exists
    fs.mkdirSync(dir, { recursive: true });

    try {
        // 1. Write to temp file
        fs.writeFileSync(tmpFile, data, { encoding, mode });

        // 2. Try atomic rename
        try {
            fs.renameSync(tmpFile, filePath);
            return;
        } catch (renameErr) {
            if (renameErr.code !== 'EPERM' && renameErr.code !== 'EACCES') {
                throw renameErr;
            }
        }

        // 3. Windows fallback
        try {
            fs.unlinkSync(filePath);
        } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') {
                throw unlinkErr;
            }
        }
        fs.renameSync(tmpFile, filePath);

    } catch (err) {
        try {
            fs.unlinkSync(tmpFile);
        } catch {
            // Ignore cleanup errors
        }
        throw err;
    }
}

module.exports = { atomicWrite, atomicWriteSync };

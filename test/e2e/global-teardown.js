const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = async function globalTeardown() {
    const tmpDir = os.tmpdir();
    try {
        const entries = fs.readdirSync(tmpDir);
        for (const entry of entries) {
            if (entry.startsWith('temp-validation-') || entry.startsWith('worker-') || entry.startsWith('partial-put-')) {
                const fullPath = path.join(tmpDir, entry);
                try {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                } catch {}
            }
        }
    } catch {}
};

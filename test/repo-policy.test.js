const fs = require('fs');
const path = require('path');

describe('Repository editor policy', () => {
    const rootDir = path.join(__dirname, '..');

    test('.editorconfig enforces UTF-8 + LF defaults', () => {
        const editorConfigPath = path.join(rootDir, '.editorconfig');
        expect(fs.existsSync(editorConfigPath)).toBe(true);

        const content = fs.readFileSync(editorConfigPath, 'utf8');
        expect(content).toMatch(/root\s*=\s*true/);
        expect(content).toMatch(/charset\s*=\s*utf-8/);
        expect(content).toMatch(/end_of_line\s*=\s*lf/);
        expect(content).toMatch(/insert_final_newline\s*=\s*true/);
    });

    test('.gitattributes pins EOL for scripts and binaries', () => {
        const gitAttributesPath = path.join(rootDir, '.gitattributes');
        expect(fs.existsSync(gitAttributesPath)).toBe(true);

        const content = fs.readFileSync(gitAttributesPath, 'utf8');
        expect(content).toMatch(/\* text=auto eol=lf/);
        expect(content).toMatch(/\.cmd text eol=crlf/);
        expect(content).toMatch(/\.bat text eol=crlf/);
        expect(content).toMatch(/\.ps1 text eol=crlf/);
        expect(content).toMatch(/\.png binary/);
    });
});

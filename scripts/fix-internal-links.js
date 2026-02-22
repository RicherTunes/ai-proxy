const fs = require('fs');
const path = require('path');

const docsDir = path.join(__dirname, '..', 'docs');

function fixInternalLinks(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  // Fix markdown links: .md -> /
  // This handles both relative and absolute links
  const originalContent = content;

  // Replace .md links with directory links
  content = content.replace(/\[([^\]]+)\]\(([^)]+\.md)\)/g, (match, text, url) => {
    modified = true;
    // Remove .md and add trailing slash
    const newUrl = url.replace(/\.md$/, '/');
    return `[${text}](${newUrl})`;
  });

  if (modified && content !== originalContent) {
    fs.writeFileSync(filePath, content);
    console.log(`Fixed internal links in ${filePath}`);
  }
}

function processDirectory(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    const fullPath = path.join(dir, file.name);

    if (file.isDirectory()) {
      processDirectory(fullPath);
    } else if (file.name.endsWith('.md')) {
      fixInternalLinks(fullPath);
    }
  }
}

console.log('Fixing internal markdown links...');
processDirectory(docsDir);
console.log('Done!');

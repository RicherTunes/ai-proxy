const fs = require('fs');
const path = require('path');

const docsDir = path.join(__dirname, '..', 'docs');

function addFrontMatter(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Skip if already has front matter
  if (content.startsWith('---')) {
    console.log(`Skipping ${filePath} - already has front matter`);
    return;
  }

  // Extract title from first heading
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : path.basename(filePath, '.md');

  const frontMatter = `---
layout: default
title: ${title}
---

`;

  fs.writeFileSync(filePath, frontMatter + content);
  console.log(`Added front matter to ${filePath}`);
}

function processDirectory(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    const fullPath = path.join(dir, file.name);

    if (file.isDirectory()) {
      processDirectory(fullPath);
    } else if (file.name.endsWith('.md')) {
      addFrontMatter(fullPath);
    }
  }
}

console.log('Adding front matter to all markdown files in docs/');
processDirectory(docsDir);
console.log('Done!');

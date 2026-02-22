const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'docs', 'index.html');
let content = fs.readFileSync(indexPath, 'utf8');

// Replace all .md links with directory links (Jekyll will create folder/index.html)
content = content.replace(/href="\.\/([^"]+)\.md"/g, 'href="./$1/"');

fs.writeFileSync(indexPath, content);
console.log('Fixed markdown links in index.html');

#!/usr/bin/env node

/**
 * Generate Search Index for AI Proxy Documentation
 *
 * This script crawls the docs directory and generates a search index JSON file
 * that can be used by the client-side search functionality.
 *
 * Usage: node scripts/generate-search-index.js
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

// Configuration
const DOCS_DIR = path.join(__dirname, '..', 'docs');
const OUTPUT_FILE = path.join(__dirname, '..', 'docs', 'search', 'index.json');
const BASE_URL = '/ai-proxy';

// Files/directories to exclude from search
const EXCLUDE = [
    'node_modules',
    '.git',
    'milestones',
    'plans',
    'screenshots',
    'search'
];

// File extensions to include
const INCLUDE_EXTENSIONS = ['.md', '.html'];

/**
 * Recursively get all documentation files
 */
function getDocFiles(dir, baseDir = dir) {
    const files = [];

    if (!fs.existsSync(dir)) {
        return files;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);

        // Skip excluded directories
        if (EXCLUDE.some(excluded => relativePath.includes(excluded))) {
            continue;
        }

        if (entry.isDirectory()) {
            // Recursively process subdirectories
            files.push(...getDocFiles(fullPath, baseDir));
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (INCLUDE_EXTENSIONS.includes(ext)) {
                files.push(fullPath);
            }
        }
    }

    return files;
}

/**
 * Extract plain text from markdown
 */
function markdownToText(markdown) {
    // Remove code blocks
    let text = markdown.replace(/```[\s\S]*?```/g, '');

    // Remove inline code
    text = text.replace(/`[^`]+`/g, '');

    // Remove images
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');

    // Remove links but keep text
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // Remove headers markers
    text = text.replace(/^#+\s+/gm, '');

    // Remove horizontal rules
    text = text.replace(/^---+$/gm, '');

    // Remove blockquotes markers
    text = text.replace(/^>\s+/gm, '');

    // Remove HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();

    return text;
}

/**
 * Extract HTML text
 */
function htmlToText(html) {
    // Remove script tags
    let text = html.replace(/<script[\s\S]*?<\/script>/gi, '');

    // Remove style tags
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');

    // Remove HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode HTML entities
    text = text.replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .replace(/&quot;/g, '"')
               .replace(/&#39;/g, "'");

    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();

    return text;
}

/**
 * Extract metadata and content from a file
 */
function processFile(filePath, docsDir) {
    const relativePath = path.relative(docsDir, filePath);
    const ext = path.extname(filePath);
    const basename = path.basename(filePath, ext);

    let content = fs.readFileSync(filePath, 'utf8');
    let title = basename.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    // Extract title from content if available
    if (ext === '.md') {
        // Look for first heading
        const titleMatch = content.match(/^#\s+(.+)$/m);
        if (titleMatch) {
            title = titleMatch[1].trim();
        }
    }

    // Extract category from directory path
    const category = path.dirname(relativePath).split(path.sep)[0] || null;

    // Extract tags from frontmatter or content
    const tags = [];

    // Look for tags in markdown frontmatter
    if (ext === '.md') {
        const tagMatch = content.match(/tags:\s*\[(.*?)\]/);
        if (tagMatch) {
            const tagList = tagMatch[1].split(',').map(t => t.trim().replace(/['"]/g, ''));
            tags.push(...tagList);
        }

        // Convert markdown to plain text
        content = markdownToText(content);
    } else if (ext === '.html') {
        // Extract text from HTML
        const titleMatch = content.match(/<title>(.*?)<\/title>/i);
        if (titleMatch) {
            title = titleMatch[1].trim();
        }

        // Look for h1
        const h1Match = content.match(/<h1[^>]*>(.*?)<\/h1>/i);
        if (h1Match) {
            title = h1Match[1].trim();
        }

        content = htmlToText(content);
    }

    // Generate URL
    let url = `${BASE_URL}/${relativePath}`;
    if (ext === '.md') {
        url = url.replace(/\.md$/, '/');
    } else if (ext === '.html') {
        url = url.replace(/\.html$/, '/');
        url = url.replace(/\/index$/, '/');
    }

    // Truncate content if too long
    const maxContentLength = 2000;
    if (content.length > maxContentLength) {
        content = content.substring(0, maxContentLength);
    }

    return {
        title,
        url,
        category,
        tags: tags.length > 0 ? tags : null,
        content
    };
}

/**
 * Generate search index
 */
function generateSearchIndex() {
    console.log('Generating search index...');
    console.log(`Docs directory: ${DOCS_DIR}`);

    // Get all documentation files
    const files = getDocFiles(DOCS_DIR);
    console.log(`Found ${files.length} files to index`);

    // Process each file
    const searchIndex = files.map(filePath => {
        try {
            return processFile(filePath, DOCS_DIR);
        } catch (error) {
            console.error(`Error processing ${filePath}:`, error.message);
            return null;
        }
    }).filter(item => item !== null);

    // Create output directory
    const outputDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write search index
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(searchIndex, null, 2));

    console.log(`Search index generated: ${OUTPUT_FILE}`);
    console.log(`Total documents: ${searchIndex.length}`);
    console.log(`Index size: ${(JSON.stringify(searchIndex).length / 1024).toFixed(2)} KB`);

    // Print some stats
    const categories = {};
    searchIndex.forEach(item => {
        if (item.category) {
            categories[item.category] = (categories[item.category] || 0) + 1;
        }
    });

    console.log('\nDocuments by category:');
    Object.entries(categories).forEach(([cat, count]) => {
        console.log(`  ${cat}: ${count}`);
    });
}

// Run the generator
if (require.main === module) {
    generateSearchIndex();
}

module.exports = { generateSearchIndex };

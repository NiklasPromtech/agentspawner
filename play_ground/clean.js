/**
 * play_ground/clean.js
 * Run: node clean.js
 *
 * Reads source.html, applies cleaning steps, writes output.html.
 * Add / comment out steps below to experiment.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source  = join(__dirname, 'source.html');
const output  = join(__dirname, 'output.html');

// ── Read ──────────────────────────────────────────────────────────────────────

let html = readFileSync(source, 'utf-8');
const originalSize = html.length;

console.log(`\nSource:  ${fmt(originalSize)}`);

// ── Cleaning steps ────────────────────────────────────────────────────────────
// Comment/uncomment steps as you experiment.

// 1. Strip all class attributes
html = html.replace(/\s+class="[^"]*"/gi, '');
html = html.replace(/\s+class='[^']*'/gi, '');
log('Strip class=""', html.length, originalSize);

// 2. Strip <script> blocks
// html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
// log('Strip <script>', html.length, originalSize);

// 3. Strip <style> blocks
// html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
// log('Strip <style>', html.length, originalSize);

// 4. Strip <svg> blocks
// html = html.replace(/<svg[\s\S]*?<\/svg>/gi, '');
// log('Strip <svg>', html.length, originalSize);

// 5. Strip HTML comments
// html = html.replace(/<!--[\s\S]*?-->/g, '');
// log('Strip comments', html.length, originalSize);

// 6. Strip aria-hidden="true" elements (full tags — aggressive)
// html = html.replace(/<[^>]+aria-hidden="true"[^>]*>[\s\S]*?<\/[a-z]+>/gi, '');
// log('Strip aria-hidden blocks', html.length, originalSize);

// 7. Strip all attributes EXCEPT href, src, alt, id, aria-label (like get_dom_filtered)
// html = html.replace(/<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g, (_m, tag, attrs = '') => {
//   const keep = ['href','src','alt','id','aria-label','type','name','value','placeholder'];
//   let kept = '';
//   for (const attr of keep) {
//     const m = attrs.match(new RegExp(`\\s${attr}=["']([^"']*)["']`, 'i'));
//     if (m) kept += ` ${attr}="${m[1]}"`;
//   }
//   return `<${tag}${kept}>`;
// });
// log('Strip all attrs except semantic', html.length, originalSize);

// 8. Collapse whitespace
// html = html.replace(/\s{2,}/g, ' ').trim();
// log('Collapse whitespace', html.length, originalSize);

// ── Write ─────────────────────────────────────────────────────────────────────

writeFileSync(output, html, 'utf-8');
console.log(`\nOutput:  ${fmt(html.length)}  (${pct(html.length, originalSize)} of original)`);
console.log(`Written: output.html\n`);

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} MB`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
}

function pct(after, before) {
  return `${((after / before) * 100).toFixed(1)}%`;
}

function log(label, current, original) {
  console.log(`  ✓ ${label.padEnd(40)} ${fmt(current).padStart(10)}  (${pct(current, original)})`);
}

#!/usr/bin/env node
/**
 * build-ext.mjs — ARM64-safe build script for the Chrome extension.
 *
 * Why this exists: Vite/Rollup requires a native ARM64 binary that is not
 * present in this environment. esbuild has the same problem. This script
 * uses the TypeScript compiler API (pure JS, no native code) to transpile
 * and bundle all four entry points directly.
 *
 * Entry points and their bundling strategy:
 *   background/index.ts  — only type imports → transpile as ES module
 *   offscreen/index.ts   — only type imports → transpile as ES module
 *   popup/index.ts       — no imports        → transpile as ES module
 *   content/index.ts     — imports PRIMITIVES from ../primitives/index.ts
 *                          → inline primitives, transpile as classic script,
 *                            wrap in IIFE guard (prevents double-injection)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load TypeScript compiler (pure JS, no native binary needed)
const ts = require('./node_modules/typescript/lib/typescript.js');

const SRC  = join(__dirname, 'src');
const DIST = join(__dirname, 'dist');
const PUB  = join(__dirname, 'public');

// ── Helpers ──────────────────────────────────────────────────────────────────

function read(rel) {
  return readFileSync(join(SRC, rel), 'utf8');
}

function writeOut(rel, code) {
  const full = join(DIST, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, code, 'utf8');
  console.log(`  wrote ${rel} (${code.length} bytes)`);
}

/** Transpile a TypeScript string to JavaScript using tsc API.
 *  @param {string} source  TypeScript source code
 *  @param {'ESNext'|'None'} moduleKind  ESNext = ES modules, None = classic script
 */
function transpile(source, moduleKind = 'ESNext') {
  const kind = moduleKind === 'None' ? ts.ModuleKind.None : ts.ModuleKind.ESNext;
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: kind,
      strict: false,
      skipLibCheck: true,
      esModuleInterop: true,
    },
    // Suppress "import type" warnings in transpileModule mode
    reportDiagnostics: false,
  });
  return result.outputText;
}

/** Recursively copy a directory tree, overwriting any existing files. */
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) {
      copyDir(s, d);
    } else {
      writeFileSync(d, readFileSync(s));
    }
  }
}

// ── Step 1: Ensure dist/ exists ─────────────────────────────────────────────

console.log('\n[build-ext] Preparing dist/...');
mkdirSync(DIST, { recursive: true });

// ── Step 2: Copy public/ → dist/ (overwrite existing files) ─────────────────

console.log('[build-ext] Copying public/ → dist/...');
copyDir(PUB, DIST);

// ── Step 3: background/index.ts — only type imports ─────────────────────────

console.log('[build-ext] Compiling background/index.ts...');
{
  const src = read('background/index.ts');
  const js = transpile(src, 'ESNext');
  writeOut('background/index.js', js);
}

// ── Step 4: offscreen/index.ts — only type imports ──────────────────────────

console.log('[build-ext] Compiling offscreen/index.ts...');
{
  const src = read('offscreen/index.ts');
  const js = transpile(src, 'ESNext');
  writeOut('offscreen/index.js', js);
}

// ── Step 5: popup/index.ts — no imports ─────────────────────────────────────

console.log('[build-ext] Compiling popup/index.ts...');
{
  const src = read('popup/index.ts');
  const js = transpile(src, 'ESNext');
  writeOut('popup/index.js', js);
}

// ── Step 6: content/index.ts — needs primitives inlined ─────────────────────

console.log('[build-ext] Bundling content/index.ts (inlining primitives)...');
{
  const primitivesSrc = read('primitives/index.ts');
  const contentSrc    = read('content/index.ts');

  // Strip all export keywords from primitives so they become plain declarations.
  // 'export interface' → 'interface', 'export function' → 'function', etc.
  const primitivesStripped = primitivesSrc
    .replace(/^export (interface|type|function|const|async function|class)/gm, '$1');

  // Remove the runtime import of PRIMITIVES from content (now it will be in scope)
  // and remove any 'import type' lines (erased at compile time anyway)
  const contentStripped = contentSrc
    .replace(/^import type\s.*\n/gm, '')
    .replace(/^import \{ PRIMITIVES \} from ['"]\.\.\/primitives\/index\.js['"];?\n/m, '');

  // Combine: primitives first so PRIMITIVES is in scope for content
  const combined = `${primitivesStripped}\n\n${contentStripped}`;

  // Transpile as a classic (non-module) script
  const transpiled = transpile(combined, 'None');

  // Wrap in the guard IIFE — prevents double-injection if content script runs twice
  const guarded = [
    '(function () {',
    '  if (window.__agentSpawnerLoaded) return;',
    '  window.__agentSpawnerLoaded = true;',
    '',
    transpiled.trimEnd(),
    '})(); // end guard IIFE',
  ].join('\n');

  writeOut('content/index.js', guarded);
}

// ── Step 7: flows-debugger/index.ts — no imports ─────────────────────────────

console.log('[build-ext] Compiling flows-debugger/index.ts...');
{
  const src = read('flows-debugger/index.ts');
  const js = transpile(src, 'ESNext');
  writeOut('flows-debugger/index.js', js);
}

// ── Step 7b: Copy flows-debugger/index.html → dist/flows-debugger/ ───────────

console.log('[build-ext] Copying flows-debugger/index.html...');
{
  const htmlSrc = join(SRC, 'flows-debugger/index.html');
  const htmlDest = join(DIST, 'flows-debugger/index.html');
  mkdirSync(dirname(htmlDest), { recursive: true });
  writeFileSync(htmlDest, readFileSync(htmlSrc));
  console.log('  wrote flows-debugger/index.html');
}

// ── Step 9: Type-check (no emit) ─────────────────────────────────────────────

console.log('[build-ext] Type-checking (tsc --noEmit)...');
try {
  execSync(
    './node_modules/.bin/tsc --noEmit',
    { cwd: __dirname, stdio: 'inherit' }
  );
  console.log('[build-ext] Type check passed.');
} catch {
  // tsc exits non-zero on type errors; report but don't abort the build so
  // the extension can still be loaded and tested incrementally.
  console.warn('[build-ext] WARNING: type errors detected (see above). Build output was still written.');
}

console.log('\n[build-ext] Done. Extension is ready in dist/\n');

#!/usr/bin/env node
// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Walks api/src/routes/**\/*.ts, finds Fastify route registrations
 * (server.get/post/put/patch/delete) and extracts the `schema` block:
 * body, querystring, params.
 *
 * Output: scripts/route-schemas.json — map keyed by `${METHOD} ${path}`.
 *
 * This is the GROUND TRUTH for what the production server expects, since
 * the public OpenAPI extractor only registers a subset of routes.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROUTES_DIR = process.env.ROUTES_DIR || path.resolve('api/src/routes');
const OUT = process.env.OUT || path.resolve('scripts/route-schemas.json');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...walk(p));
    } else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Tokenize-ish parse: given a string offset where `{` starts, return the
 * matching closing `}` offset (handles nested braces, strings, comments).
 */
function findMatchingBrace(src, start) {
  let depth = 0;
  let i = start;
  let inStr = null;
  let inTpl = false;
  let inLine = false;
  let inBlock = false;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; i++; continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i += 2; continue; } i++; continue; }
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) { inStr = null; }
      i++; continue;
    }
    if (inTpl) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') inTpl = false;
      // Note: ${ ... } interpolation is not handled fully; OK for our use.
      i++; continue;
    }
    if (c === '/' && next === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'") { inStr = c; i++; continue; }
    if (c === '`') { inTpl = true; i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Extract a JS-like object literal substring starting at `start` (must point at `{`).
 * Returns { code, end }.
 */
function extractObjectLiteral(src, start) {
  if (src[start] !== '{') return null;
  const end = findMatchingBrace(src, start);
  if (end < 0) return null;
  return { code: src.slice(start, end + 1), end };
}

/**
 * Convert a JS object literal source to JSON-like: strip TS types,
 * quote unquoted keys, replace single quotes, drop trailing commas.
 *
 * This is a heuristic — good enough to extract `body`/`querystring`/`params`
 * subtrees that are pure data (Fastify JSON Schema fragments).
 */
function jsObjectToJsonish(src) {
  let s = src;
  // Remove line + block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.replace(/(^|[^:])\/\/[^\n]*/g, (_, p1) => p1);
  // Remove `as const` / `as Type` casts
  s = s.replace(/\s+as\s+[A-Za-z0-9_<>\[\],\s|]+(?=[,\}\]])/g, '');
  // Quote unquoted object keys: { foo: ... } → { "foo": ... }
  // (only word keys at object positions, not after `.` or in strings)
  s = s.replace(/([\{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
  // Replace single-quoted strings with double-quoted
  s = s.replace(/'((?:[^'\\]|\\.)*)'/g, (_, body) => '"' + body.replace(/"/g, '\\"').replace(/\\'/g, "'") + '"');
  // Drop trailing commas
  s = s.replace(/,(\s*[\}\]])/g, '$1');
  return s;
}

function tryParseJsonish(src) {
  try {
    return JSON.parse(jsObjectToJsonish(src));
  } catch {
    return null;
  }
}

/** Inside an options object literal, find `schema: { ... }` and parse subkeys. */
function parseSchemaBlock(optsCode) {
  // Find `schema:` followed by `{`.
  const m = optsCode.match(/[\s\S]*?\bschema\s*:\s*\{/);
  if (!m) return null;
  const start = m.index + m[0].length - 1; // position of `{`
  const obj = extractObjectLiteral(optsCode, start);
  if (!obj) return null;
  const schema = tryParseJsonish(obj.code);
  return schema;
}

/** Find route registrations: server.get('path'|"path"|`path`, OPTS|HANDLER, ...) */
function extractRoutes(src) {
  const out = [];
  const re = /\bserver\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const method = m[1].toUpperCase();
    const callStart = m.index + m[0].length;
    // Parse args: first is a string path; second may be options object
    let i = callStart;
    while (i < src.length && /\s/.test(src[i])) i++;
    const ch = src[i];
    if (ch !== '"' && ch !== "'" && ch !== '`') continue;
    const quote = ch;
    let j = i + 1;
    let routePath = '';
    while (j < src.length && src[j] !== quote) {
      if (src[j] === '\\' && j + 1 < src.length) { routePath += src[j+1]; j += 2; continue; }
      routePath += src[j];
      j++;
    }
    j++; // past closing quote
    // Skip whitespace + ,
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== ',') continue;
    j++;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== '{') {
      // No options object — skip
      out.push({ method, path: routePath, schema: null });
      continue;
    }
    const optsObj = extractObjectLiteral(src, j);
    if (!optsObj) continue;
    const schema = parseSchemaBlock(optsObj.code);
    out.push({ method, path: routePath, schema });
  }
  return out;
}

const files = walk(ROUTES_DIR);
console.log(`Scanning ${files.length} route files...`);

const map = {};
let totalRoutes = 0;
let withSchema = 0;
const failures = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const routes = extractRoutes(src);
  for (const r of routes) {
    if (!r.path) continue;
    totalRoutes++;
    const key = `${r.method} ${r.path}`;
    if (!map[key]) map[key] = { sourceFile: path.relative(ROUTES_DIR, file), schema: null };
    if (r.schema) {
      map[key].schema = r.schema;
      withSchema++;
    }
  }
}

console.log(`Total routes: ${totalRoutes}, with parsed schema: ${withSchema}`);
console.log(`Distinct keys: ${Object.keys(map).length}`);

fs.writeFileSync(OUT, JSON.stringify(map, null, 2));
console.log(`Wrote ${OUT}`);

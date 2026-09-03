// ─── Names used but never declared ───────────────────────────────────────────
//
// Three times in one session a change shipped that referenced something which
// did not exist, and every time the tests passed and the page loaded clean:
//
//   armSpan   an addition referenced a const a failed patch never wrote
//   FINGERS   an addition used an export it never imported
//   _curls    a deletion by line range took three live scratches with it
//
// All three threw only once TRACKING was running, which needs a camera. So the
// two checks that exist -- `npm test` and loading the page -- are both blind to
// exactly this, and it is the single most common way this repo has broken.
//
// ── Why this is not a linter ──
//
// A real no-undef needs a parser, and this project has no dependencies and is
// not about to grow one for this. So it checks the two shapes that actually
// went wrong, precisely, with no false positives to train anyone to ignore:
//
//   1. Scratch names. The codebase spells every reused vector `_thing`, which
//      makes them unambiguous to find and to attribute -- no parameter, no
//      property and no global looks like that.
//   2. Module-scope names of the file's OWN imports. If a file imports from
//      ./pose.js and then calls something pose.js exports without naming it in
//      the import list, that is the FINGERS bug, and it is decidable.
//
// It deliberately says nothing about anything else. A guard that cries wolf
// gets muted, and a muted guard is worse than no guard at all -- an earlier
// attempt at the general version did exactly that and was deleted.
//
// Run: npm run refs

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

function jsFiles(dir, found = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) jsFiles(path, found);
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

/** Comments, strings and template literals are not uses. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** The names a module exports, by declaration. */
function exportsOf(path) {
  const src = readFileSync(join(ROOT, path), 'utf8');
  return new Set(
    [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)]
      .map(m => m[1]),
  );
}

const problems = [];

for (const file of jsFiles('js')) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const code = codeOnly(src);

  // Imports are read from the RAW source, never from `code`: a specifier is a
  // string literal, and codeOnly() replaces every string with an empty one --
  // so parsing them out of the stripped text yields '' for every module and
  // silently skips the whole check below. This guard passed a reintroduced bug
  // because of exactly that, which is the failure it exists to not have.
  const imported = new Map();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const names = m[1].split(',').map(n => n.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
    imported.set(m[2], new Set([...(imported.get(m[2]) ?? []), ...names]));
  }
  const allImported = new Set([...imported.values()].flatMap(set => [...set]));

  // ── 1. Scratch names ──
  const declaredScratch = new Set(
    [...code.matchAll(/(?:const|let|var|function)\s+(_[\w$]*)/g)].map(m => m[1]),
  );
  for (const m of code.matchAll(/(?<![.\w$])(_[A-Za-z][\w$]*)/g)) {
    const name = m[1];
    if (declaredScratch.has(name) || allImported.has(name)) continue;
    problems.push(`${file}: uses ${name}, which nothing in the file declares`);
  }

  // ── 2. Names that belong to a module this file already imports from ──
  for (const [specifier] of imported) {
    if (!specifier.startsWith('.')) continue;
    const target = resolve(dirname(join(ROOT, file)), specifier).slice(ROOT.length + 1);
    let theirs;
    try { theirs = exportsOf(target); } catch { continue; }
    const declaredHere = new Set([
      ...[...code.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
      ...allImported,
    ]);
    for (const name of theirs) {
      if (declaredHere.has(name)) continue;
      // Used as a call, a property access or an index -- the shapes a missing
      // binding actually takes.
      if (new RegExp(`(?<![.\\w$])${name}\\s*[({.[]`).test(code)) {
        problems.push(`${file}: uses ${name} from ${specifier} without importing it`);
      }
    }
  }
}

const unique = [...new Set(problems)];
if (unique.length) {
  console.error(`\n${unique.length} reference problem${unique.length === 1 ? '' : 's'}:\n`);
  for (const line of unique) console.error(`  ${line}`);
  console.error('');
  process.exit(1);
}
console.log('references ok');

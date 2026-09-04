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
//   3. Calls to a name this file never binds. A block deletion that takes a
//      helper out while its callers stay behind leaves a file that parses, that
//      passes every test, and that throws the first time the deleted line is
//      reached -- which for this project is the first time somebody turns a
//      CAMERA on. `readBowSign` went that way and cost an afternoon: checks 1
//      and 2 both said the file was fine, because it was neither a scratch name
//      nor an import.
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

/**
 * Comments, strings and template literals are not uses.
 *
 * ── Why this is a scanner and not five replaces ──
 *
 * It was five replaces, and one of them could not do the job: a template
 * literal with another template literal inside its `${}` is not a regular
 * language, and the pattern that tried stopped at the first `}` it saw. The
 * inner backtick then closed the OUTER literal early and everything after it
 * was read one state out of step -- in practice.js that swallowed sixty lines
 * of real code, `function resize` among them.
 *
 * So the checks below were running against a mangled copy of the very file most
 * likely to need them, and quietly reporting nothing. A guard that is wrong
 * about what the code even says is worse than no guard: it is a green tick over
 * a hole.
 *
 * One pass, one state machine, `${}` depth counted. Comments and string bodies
 * become spaces so every offset still lines up with the source.
 */
function codeOnly(src) {
  let out = '';
  let i = 0;
  // Depth of `${` nesting per open template literal, innermost last. A depth of
  // 0 means "inside the literal's TEXT"; anything higher is real code again.
  const templates = [];
  const blank = text => text.replace(/[^\n]/g, ' ');
  const inTemplateText = () => templates.length > 0 && templates.at(-1) === 0;

  /** Is the `/` at `at` opening a regex, or dividing? Decided by what precedes. */
  function startsRegex(at) {
    let j = at - 1;
    while (j >= 0 && /\s/.test(src[j])) j -= 1;
    if (j < 0) return true;
    if ('(,=:[!&|?{};+-*%^~<>'.includes(src[j])) return true;
    // `return /re/`, `typeof /re/`, `case /re/` -- a word that cannot end an
    // expression, so what follows must start one.
    const word = /[\w$]+$/.exec(src.slice(0, j + 1))?.[0];
    return ['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'new'].includes(word);
  }

  while (i < src.length) {
    const two = src.slice(i, i + 2);
    const c = src[i];

    // ── Template TEXT first ──
    //
    // Everything below is a thing that only exists in code, and inside the text
    // of a template literal none of it applies. Checking comments before this
    // is how `\`${protocol}//${host}\`` ate its own closing backtick and sixty
    // lines after it: the // in a URL is not a comment, it is text.
    if (inTemplateText()) {
      if (c === '`') { templates.pop(); out += ' '; i += 1; continue; }
      if (two === '${') { templates[templates.length - 1] = 1; out += '  '; i += 2; continue; }
      if (c === '\\') { out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += blank(src.slice(i, Math.min(j + 1, src.length)));
      i = j + 1;
      continue;
    }
    // A regex literal's body is not code: /^Right(Shoulder|Arm)$/ has no call in
    // it, whatever the parenthesis looks like from outside.
    if (c === '/' && startsRegex(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        else if (ch === '\n') break;              // unterminated: not a regex after all
        j += 1;
      }
      if (src[j] === '/') {
        while (j + 1 < src.length && /[a-z]/.test(src[j + 1])) j += 1;   // flags
        out += blank(src.slice(i, j + 1));
        i = j + 1;
        continue;
      }
    }
    if (c === '`') { templates.push(0); out += ' '; i += 1; continue; }
    if (templates.length && c === '{') templates[templates.length - 1] += 1;
    if (templates.length && c === '}') {
      templates[templates.length - 1] -= 1;
      if (templates.at(-1) === 0) { out += ' '; i += 1; continue; }
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The names a module exports, by declaration. */
function exportsOf(path) {
  const src = readFileSync(join(ROOT, path), 'utf8');
  return new Set(
    [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)]
      .map(m => m[1]),
  );
}

/**
 * Everything a browser hands a module for free, plus the keywords that look
 * like calls. Not a lint of the language -- just enough that check 3 can tell
 * `readBowSign(` from `if (`.
 */
const GLOBALS = new Set([
  // keywords and operators that are followed by a parenthesis
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'void', 'await',
  'function', 'new', 'delete', 'in', 'of', 'do', 'else', 'yield', 'instanceof',
  'async', 'import', 'super', 'this',
  // the standard library
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math',
  'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Promise',
  'Set', 'Map', 'WeakSet', 'WeakMap', 'Proxy', 'Reflect', 'Intl',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'structuredClone', 'queueMicrotask',
  // typed arrays and buffers
  'ArrayBuffer', 'DataView', 'Uint8Array', 'Uint16Array', 'Uint32Array',
  'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array',
  // the page
  'window', 'document', 'navigator', 'location', 'history', 'screen',
  'performance', 'console', 'fetch', 'Image', 'Audio', 'Blob', 'File',
  'FileReader', 'FormData', 'Headers', 'Request', 'Response', 'URL',
  'URLSearchParams', 'WebSocket', 'Worker', 'AbortController', 'EventTarget',
  'CustomEvent', 'Event', 'MutationObserver', 'ResizeObserver',
  'IntersectionObserver', 'createImageBitmap', 'getComputedStyle', 'matchMedia',
  'alert', 'confirm', 'prompt', 'atob', 'btoa', 'reportError',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'addEventListener', 'removeEventListener',
  'importScripts', 'postMessage', 'close', 'open',
  // node, for the scripts under js/ that run there
  'require', 'process', 'Buffer',
]);

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

  // ── 3. Calls to a name this file never binds ──
  //
  // Bindings are collected as WIDELY as the shapes below allow, on purpose. A
  // name wrongly counted as bound means one missed bug; a name wrongly counted
  // as unbound means a false alarm, and a guard that cries wolf gets muted --
  // which is how the general version of this check died the first time. When in
  // doubt this stays quiet.
  const bound = new Set([
    ...allImported,
    // const / let / var / class, and function -- including `function*`, whose
    // star sits between the keyword and the name and defeated a plain \s+.
    ...[...code.matchAll(/(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
    ...[...code.matchAll(/function\s*\*?\s*([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
    // Everything on the left of a declaration's `=`, whatever shape it is:
    // `const [{ clone }, gltf] = ...` binds `clone`, and no pattern aimed at one
    // shape of destructuring is going to keep up with the shapes people write.
    ...[...code.matchAll(/(?:const|let|var)\s+([^=;\n]+)=/g)]
      .flatMap(m => [...m[1].matchAll(/([A-Za-z_$][\w$]*)/g)].map(x => x[1])),
    // every identifier inside a parameter list, a destructuring, or a catch
    ...[...code.matchAll(/(?:function\s*[\w$]*\s*|catch\s*)\(([^)]*)\)/g)]
      .flatMap(m => [...m[1].matchAll(/([A-Za-z_$][\w$]*)/g)].map(x => x[1])),
    ...[...code.matchAll(/\(([^()]*)\)\s*=>/g)]
      .flatMap(m => [...m[1].matchAll(/([A-Za-z_$][\w$]*)/g)].map(x => x[1])),
    ...[...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*=>/g)].map(m => m[1]),
    ...[...code.matchAll(/[{[]([^{}[\]]*)[}\]]\s*=/g)]
      .flatMap(m => [...m[1].matchAll(/([A-Za-z_$][\w$]*)/g)].map(x => x[1])),
    // Anything assigned to. Covers a destructured parameter with a default --
    // `createRoomClient({ onPeer = () => {} })` binds onPeer -- which no pattern
    // aimed at the parameter LIST can see, because the list contains parentheses
    // of its own and stops being scannable at the first one.
    ...[...code.matchAll(/([A-Za-z_$][\w$]*)\s*=(?![=>])/g)].map(m => m[1]),
    // object and class method shorthand: `name(args) {`
    ...[...code.matchAll(/(?:^|[{,;]|\bget\b|\bset\b|\basync\b)\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)]
      .map(m => m[1]),
    // for (const x of ...) is covered by the const rule; labels are not calls.
  ]);

  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (bound.has(name) || GLOBALS.has(name)) continue;
    problems.push(`${file}: calls ${name}, which nothing in the file declares or imports`);
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

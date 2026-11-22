// Faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// A fresh, from-spec reimplementation of makefun-site's build(): front matter,
// slug rule, Markdown subset, template dialect, collections, tags, permalinks,
// link resolution and build-report.txt — byte-identical output, written for
// CPU time: single-pass block/inline parsing with chunked string building
// (no per-character concatenation), an ASCII fast path for slugs, flat
// template node arrays rendered into one output array, and no regexes in
// the hot loops. Node 22 stdlib only, no network, deterministic.

const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
/** `text` with & < > " and ' escaped. */
function esc(s) {
  return s.replace(ESC_RE, (c) => ENT[c]);
}

export const SLUG_MAX = 64;

/** The slug of `text` (README.md, "Text"). ASCII fast path; the Unicode path is the reference algorithm. */
export function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (ascii) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        if (out.length > 0) gap = true;
        continue;
      }
      if (gap) { out += '-'; gap = false; }
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, 4)}`;
}

/** Whether char code `c` is JS whitespace (\s). */
function isWSCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < text.length; i++) {
    if (isWSCode(text.charCodeAt(i))) inW = false;
    else if (!inW) { inW = true; n++; }
  }
  return n;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error }. `text` has "\n" line ends. */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // The closing "---" line is found first: a source whose front matter is not closed is refused
  // for that, whatever its lines hold. The body starts after the closing line.
  let scan = firstNl === -1 ? text.length : firstNl + 1;
  let closeStart = -1;
  let closeLineEnd = -1;
  while (scan < text.length) {
    const nl = text.indexOf('\n', scan);
    const lineEnd = nl === -1 ? text.length : nl;
    if (text.slice(scan, lineEnd) === '---') {
      closeStart = scan;
      closeLineEnd = lineEnd;
      break;
    }
    if (nl === -1) break;
    scan = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let curLine = 2;
  scan = firstNl + 1;
  while (scan < closeStart) {
    const nl = text.indexOf('\n', scan);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(scan, lineEnd);
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${curLine} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) break;
    scan = nl + 1;
    curLine++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeLineEnd === text.length ? '' : text.slice(closeLineEnd + 1);
  return { data, body };
}

/** Whether `line` holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ---------------------------------------------------------------- Markdown

/** `line` trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** The fence language of a fence-opening line, or null. */
function fenceOpen(s) {
  if (s.charCodeAt(0) !== 96 || s.charCodeAt(1) !== 96 || s.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = s.slice(3, j);
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function isFenceClose(s) {
  if (s.charCodeAt(0) !== 96 || s.charCodeAt(1) !== 96 || s.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(s) {
  let h = 0;
  while (h < s.length && s.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6 || h >= s.length) return null;
  const c = s.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let j = h;
  while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
  let end = s.length;
  while (end > j && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  if (end <= j) return null;
  return { depth: h, text: s.slice(j, end) };
}

/** Whether `line` is a thematic break. */
function isHR(s) {
  const c0 = s.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (s.charCodeAt(1) !== c0 || s.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The item text of a bullet line (`- ` / `* `), or null. */
function bulletOf(s) {
  const c0 = s.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && s.charCodeAt(1) === 32) return s.slice(2);
  return null;
}

/** The { num, text } of an ordered-list line, or null. */
function orderedOf(s) {
  let d = 0;
  while (d < 9 && d < s.length) {
    const c = s.charCodeAt(d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d === 0) return null;
  if (d === 9 && s.length > 9 && s.charCodeAt(9) >= 48 && s.charCodeAt(9) <= 57) return null;
  if (s.charCodeAt(d) !== 46 || s.charCodeAt(d + 1) !== 32) return null;
  return { num: s.slice(0, d), text: s.slice(d + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(s) {
  let j = 0;
  while (j < s.length && s.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= s.length) return false;
  return !isWSCode(s.charCodeAt(j));
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

// --- inline

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
/** The first index from `from` (before `end`) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  for (let j = from; j <= end - what.length; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (before `end`), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `target` holds whitespace. */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWSCode(s.charCodeAt(i))) return true;
  return false;
}

/**
 * `s[start..end]` rendered inline into `out` (an array of string chunks); `link(target)` is a link's href.
 * A native regex scan jumps from one special character to the next; the plain runs between them are
 * pushed whole. INLINE_RE is shared and reentrant-safe: every path that resumes the loop (re)sets
 * its lastIndex, and every entry sets it to `start`.
 */
const INLINE_RE = /[\\`*\[&<>"']/g;

function inlineInto(s, link, out, start, end) {
  let lit = start;
  INLINE_RE.lastIndex = start;
  let m;
  while ((m = INLINE_RE.exec(s)) !== null && m.index < end) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < end && ESCAPABLE.has(s[i + 1])) {
        if (lit < i) out.push(s.slice(lit, i));
        out.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]);
        lit = i + 2;
        INLINE_RE.lastIndex = lit;
        continue;
      }
      continue; // any other "\" is itself; it stays in the plain run
    }
    if (c === 96) { // backtick
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        if (lit < i) out.push(s.slice(lit, i));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        lit = j + 1;
        INLINE_RE.lastIndex = lit;
        continue;
      }
      continue; // a lone backtick is itself; it stays in the plain run
    }
    if (c === 42) { // *
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, end);
        if (j > i + 2) {
          if (lit < i) out.push(s.slice(lit, i));
          out.push('<strong>');
          inlineInto(s, link, out, i + 2, j);
          out.push('</strong>');
          lit = j + 2;
        } else {
          if (lit < i) out.push(s.slice(lit, i));
          out.push('**');
          lit = i + 2;
        }
        INLINE_RE.lastIndex = lit;
        continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j > i + 1) {
        if (lit < i) out.push(s.slice(lit, i));
        out.push('<em>');
        inlineInto(s, link, out, i + 1, j);
        out.push('</em>');
        lit = j + 1;
        INLINE_RE.lastIndex = lit;
      }
      continue; // a lone * is itself; it stays in the plain run
    }
    if (c === 91) { // [
      const k = findUnescaped(s, ']', i + 1, end);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 || mm >= end ? '' : s.slice(k + 2, mm);
      if (target !== '' && !hasWS(target)) {
        if (lit < i) out.push(s.slice(lit, i));
        out.push('<a href="', esc(link(target)), '">');
        inlineInto(s, link, out, i + 1, k);
        out.push('</a>');
        lit = mm + 1;
        INLINE_RE.lastIndex = lit;
        continue;
      }
      continue; // a "[" that opens no link is itself
    }
    // one of & < > " '
    if (lit < i) out.push(s.slice(lit, i));
    out.push(ENT[s[i]]);
    lit = i + 1;
    INLINE_RE.lastIndex = lit;
  }
  if (lit < end) out.push(s.slice(lit, end));
}

/** `s` rendered inline, as a string. */
function inlineStr(s, link) {
  const out = [];
  inlineInto(s, link, out, 0, s.length);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      out.push('<pre><code');
      if (lang !== '') { out.push(' class="language-', esc(lang), '"'); }
      out.push('>');
      while (i < n && !isFenceClose(lines[i])) { out.push(esc(lines[i]), '\n'); i++; }
      i++;
      out.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, link);
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push(`<blockquote>\n<p>${inlineStr(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let start = 1;
      if (isOrdered) start = Number(ordered.num);
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
        } else {
          const m = bulletOf(l);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
        }
        if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
      for (const parts of items) out.push(`<li>${inlineStr(parts.join('\n'), link)}</li>\n`);
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

export class TemplateError extends Error {}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Node kinds: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include.
// text [0, text]; var [1, path]; raw [2, path]; if [3, not, path, then, else|null];
// for [4, name, path, body]; include [5, name].

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = [];
  const stack = [root];
  let body = root;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') { body.push([0, tok.text]); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push([tok.t === 'var' ? 1 : 2, tok.path]); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR.exec(tag)) !== null) {
      const node = [4, m[1], pathOf(name, m[2]), []];
      body.push(node);
      stack.push(node);
      body = node[3];
    } else if ((m = IF.exec(tag)) !== null) {
      const node = [3, m[1] !== undefined, pathOf(name, m[2]), [], null];
      body.push(node);
      stack.push(node);
      body = node[3];
    } else if (tag === 'else') {
      if (top[0] !== 3 || top[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top[4] = [];
      body = top[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top[0] !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent === root ? root : parent[0] === 4 ? parent[3] : (parent[4] ?? parent[3]);
    } else if ((m = INCLUDE.exec(tag)) !== null) body.push([5, m[1]]);
    else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1][0] === 4 ? 'for' : 'if'} is not closed`);
  return root;
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` in `scope`; `ctx` holds the parsed templates, the memo and its guard. */
function renderNodes(nodes, scope, ctx, depth, out) {
  const templates = ctx.templates;
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n[0]) {
      case 0:
        out.push(n[1]);
        break;
      case 1:
        out.push(esc(textOf(lookup(scope, n[1]))));
        break;
      case 2:
        out.push(textOf(lookup(scope, n[1])));
        break;
      case 3: {
        const v = truthy(lookup(scope, n[2]));
        const branch = v !== n[1] ? n[3] : n[4];
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 4: {
        const xs = lookup(scope, n[2]);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {};
          vars[n[1]] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n[3], { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 5: {
        const t = templates.get(n[1]);
        if (t === undefined || depth >= 8) break;
        // A template whose rendering reads only the case-constant values (site, tags, recent) renders
        // the same at every include site of the same depth, so it is rendered once and reused.
        if (ctx.enabled && ctx.constant.has(n[1])) {
          const key = `${n[1]}#${depth}`;
          let s = ctx.memo.get(key);
          if (s === undefined) {
            const tmp = [];
            renderNodes(t, scope, ctx, depth + 1, tmp);
            s = tmp.join('');
            ctx.memo.set(key, s);
          }
          out.push(s);
        } else renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/**
 * The root names a template's rendering reads from its enclosing scope: a name bound by a for loop
 * inside the rendering (the loop's own variable, or `loop`) does not count, since its value comes
 * from the loop's source, which is itself read from the enclosing scope and counted there. Includes
 * share scope, so the walk descends into them with the bound set as it stands. The include graph
 * must be a DAG for this to be exact: a cycle (or a for loop binding `site`, `tags` or `recent`,
 * which would shadow the case-constant values) disables memoization for the case.
 */
function constantTemplates(templates) {
  const CONST = new Set(['site', 'tags', 'recent']);
  const binders = new Set();
  for (const nodes of templates.values()) {
    const walkBinders = (ns) => {
      for (const n of ns) {
        if (n[0] === 4) { binders.add(n[1]); walkBinders(n[3]); }
        else if (n[0] === 3) { walkBinders(n[3]); if (n[4] !== null) walkBinders(n[4]); }
      }
    };
    walkBinders(nodes);
  }
  if (binders.has('site') || binders.has('tags') || binders.has('recent')) return { enabled: false, constant: new Set() };
  const memo = new Map();
  const visiting = new Set();
  let cyclic = false;
  const readsOf = (name, bound) => {
    const key = `${name}\n${[...bound].sort().join(',')}`;
    if (visiting.has(key)) { cyclic = true; return new Set(); }
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const out = new Set();
    memo.set(key, out);
    visiting.add(key);
    const walk = (ns, b) => {
      for (const n of ns) {
        if (n[0] === 1 || n[0] === 2) {
          if (!b.has(n[1][0])) out.add(n[1][0]);
        } else if (n[0] === 3) {
          if (!b.has(n[2][0])) out.add(n[2][0]);
          walk(n[3], b);
          if (n[4] !== null) walk(n[4], b);
        } else if (n[0] === 4) {
          if (!b.has(n[2][0])) out.add(n[2][0]);
          const b2 = new Set(b);
          b2.add(n[1]);
          b2.add('loop');
          walk(n[3], b2);
        } else if (n[0] === 5) {
          const t = templates.get(n[1]);
          if (t !== undefined) {
            const sub = readsOf(n[1], b);
            for (const r of sub) out.add(r);
          }
        }
      }
    };
    walk(templates.get(name), bound);
    visiting.delete(key);
    return out;
  };
  const constant = new Set();
  for (const name of templates.keys()) {
    const reads = readsOf(name, new Set());
    if (cyclic) return { enabled: false, constant: new Set() };
    let ok = true;
    for (const r of reads) if (!CONST.has(r)) { ok = false; break; }
    if (ok) constant.add(name);
  }
  return { enabled: true, constant };
}

// ---------------------------------------------------------------- the build

/** Whether `target` holds a scheme (e.g. `https:`). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. */
export function run(input) {
  // 2. Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  const tnames = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of tnames) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  // Which templates read only the case-constant values, and so may be rendered once per case.
  const { enabled, constant } = constantTemplates(templates);
  const ctx = { templates, memo: new Map(), enabled, constant };

  // 1. The sources, in code-unit order of their paths; .md is a source, anything else static.
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // 3. Front matter, in source order; the first failing check is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 4. Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 6. Collections: the posts, newest date first, then by slug; newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 7. Tags: grouped by slug, each named as first met in the posts' order, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 8. Layouts.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

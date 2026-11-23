// Fast drop-in for makefun-site 1.0.0. run(input) returns byte-for-byte the
// same output tree makefun-site's build returns, but rendered with a fused
// Markdown lexer/renderer, cached slugs, a fast HTML escape, and templates
// compiled to plain JS functions (lazy, per case). No cross-case caching:
// every per-case cache is created fresh inside run().

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Per-case slug cache, replaced on every run().
let slugCache = new Map();

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/;
const ESC_RE_G = /[&<>"']/g;
export function escapeHtml(text) {
  ESC_RE_G.lastIndex = 0;
  let m = ESC_RE_G.exec(text);
  if (m === null) return text;
  let out = '';
  let start = 0;
  do {
    out += text.slice(start, m.index) + ESCAPES[m[0]];
    start = m.index + 1;
  } while ((m = ESC_RE_G.exec(text)) !== null);
  return out + text.slice(start);
}
// Append the escaped form of s to the out array, without an intermediate string
// when s holds nothing to escape.
function escPush(out, s) {
  ESC_RE_G.lastIndex = 0;
  let m = ESC_RE_G.exec(s);
  if (m === null) { out.push(s); return; }
  let start = 0;
  do {
    out.push(s.slice(start, m.index), ESCAPES[m[0]]);
    start = m.index + 1;
  } while ((m = ESC_RE_G.exec(s)) !== null);
  if (start < s.length) out.push(s.slice(start));
}

function isWS(code) {
  return code <= 32 || code === 160 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f
    || code === 0x3000 || code === 0xfeff;
}
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 32 && code < 160) {
      if (!inWord) { n++; inWord = true; }
    } else if (code <= 32) inWord = false;
    else if (code === 160 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
      || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f
      || code === 0x3000 || code === 0xfeff) inWord = false;
    else if (!inWord) { n++; inWord = true; }
  }
  return n;
}

export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  // ASCII is fixed by NFKD and holds no combining marks, so skip both steps.
  const ascii = !/[^\x00-\x7f]/.test(text);
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  if (plain === text && ascii) {
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, 64);
  while (out.endsWith('-')) out = out.slice(0, -1);
  const res = out === '' ? 'untitled' : out;
  slugCache.set(text, res);
  return res;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  while (taken.has(slug + '-' + n)) n++;
  const out = slug + '-' + n;
  taken.add(out);
  return out;
}

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePathParts(parts, rel) {
  const out = parts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

// ---------------------------------------------------------------- front matter
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
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
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
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
      if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      let ok = true;
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
        if (!ok) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      let ok = raw.length >= 1 && raw.length <= 64;
      if (ok) {
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) { ok = false; break; }
        }
        // a-z0-9, single '-' between: no leading/trailing '-', no '--'
        if (ok && (raw[0] === '-' || raw[raw.length - 1] === '-' || raw.includes('--'))) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  // Scan only the front-matter lines by line boundaries; the body is a
  // slice, never a split+join of the whole source.
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  let close = -1;
  let closeStart = -1;
  let closeEnd = -1;
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let lineNo = 1;
  let closeLineNo = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    if (line === '---') { close = lineNo; closeStart = pos; closeEnd = end; closeLineNo = lineNo; break; }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Re-walk the front-matter lines (1..close-1) for the key/value checks.
  pos = firstNl + 1;
  for (let i = 1; i < close; i++) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    pos = nl === -1 ? text.length : nl + 1;
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c !== ' ' && c !== '\t') { blank = false; break; }
    }
    if (blank || line[0] === '#') continue;
    const colon = line.indexOf(':');
    let bad = colon < 1;
    if (!bad) {
      for (let j = 0; j < colon; j++) {
        const c = line.charCodeAt(j);
        if (!((c >= 97 && c <= 122) || c === 95)) { bad = true; break; }
      }
      if (!bad && colon + 1 < line.length && line[colon + 1] !== ' ') bad = true;
    }
    if (bad) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, colon);
    let raw = colon + 1 < line.length ? line.slice(colon + 2) : '';
    let e = raw.length;
    while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
    raw = raw.slice(0, e);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd < text.length ? text.slice(closeEnd + 1) : '' };
}

// ---------------------------------------------------------------- Markdown
const ESC_CODE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESC_CODE[ch.charCodeAt(0)] = 1;
function isEscapable(code) { return code < 128 && ESC_CODE[code] === 1; }

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}
// Fence open: language or null. Fence close: boolean.
function fenceOpen(line) {
  if (line.length < 3 || line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) break;
    i++;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length ? lang : null;
}
function fenceClose(line) {
  if (line.length < 3 || line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}
function headingOf(line) {
  if (line[0] !== '#') return null;
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length || (line[n] !== ' ' && line[n] !== '\t')) return null;
  let a = n;
  while (a < line.length && (line[a] === ' ' || line[a] === '\t')) a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}
function isHR(line) {
  if (line.length < 3) return false;
  const h = line[0] === '-' && line[1] === '-' && line[2] === '-';
  const s = line[0] === '*' && line[1] === '*' && line[2] === '*';
  if (!h && !s) return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 35) return headingOf(line) !== null; // '#'
  if (c0 === 96) return fenceOpen(line) !== null; // '`'
  if (c0 === 45 || c0 === 42) return isHR(line); // '-' or '*'
  if (c0 === 32 || c0 === 9) return isBlank(line); // indented: only a blank line ends it
  return false;
}
function findUnescaped(s, what, from, hi) {
  const wl = what.length;
  for (let j = from; j + wl <= hi; j++) {
    if (s[j] === '\\' && j + 1 < hi && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== '*') continue;
    if (j + 1 < hi && s[j + 1] === '*') { j++; continue; }
    if (j + 1 >= hi) return j;
    return j;
  }
  return -1;
}
const WS_RE = /\s/;
function inlineRange(s, lo, hi, out, linkFn) {
  // Jump between the four characters that can open an inline construct.
  // The next position of each is cached and only re-scanned when the scan
  // cursor passes it, instead of re-scanning all four from the cursor on
  // every construct: most constructs contain no other special character,
  // so usually only the consumed type needs a fresh scan. A failed
  // construct is plain text: skip just its opener and keep searching,
  // exactly as the reference's per-character walk does. Stale positions
  // are refreshed at the top of the loop, after the cursor moves.
  let i = lo;
  let plain = lo;
  let nb = s.indexOf('\\', i);
  if (nb === -1 || nb >= hi) nb = -1;
  let nt = s.indexOf('`', i);
  if (nt === -1 || nt >= hi) nt = -1;
  let ns = s.indexOf('*', i);
  if (ns === -1 || ns >= hi) ns = -1;
  let nbr = s.indexOf('[', i);
  if (nbr === -1 || nbr >= hi) nbr = -1;
  while (i < hi) {
    if (nb !== -1 && nb < i) { nb = s.indexOf('\\', i); if (nb === -1 || nb >= hi) nb = -1; }
    if (nt !== -1 && nt < i) { nt = s.indexOf('`', i); if (nt === -1 || nt >= hi) nt = -1; }
    if (ns !== -1 && ns < i) { ns = s.indexOf('*', i); if (ns === -1 || ns >= hi) ns = -1; }
    if (nbr !== -1 && nbr < i) { nbr = s.indexOf('[', i); if (nbr === -1 || nbr >= hi) nbr = -1; }
    let next = hi;
    let which = 0;
    if (nb !== -1 && nb < next) { next = nb; which = 1; }
    if (nt !== -1 && nt < next) { next = nt; which = 2; }
    if (ns !== -1 && ns < next) { next = ns; which = 3; }
    if (nbr !== -1 && nbr < next) { next = nbr; which = 4; }
    if (which === 0) break;
    i = next;
    if (which === 1) {
      if (i + 1 < hi && isEscapable(s.charCodeAt(i + 1))) {
        if (i > plain) escPush(out, s.slice(plain, i));
        const ch = s[i + 1];
        out.push(ch === '>' ? '&gt;' : ch);
        i += 2;
        plain = i;
      } else i++;
      continue;
    }
    if (which === 2) {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < hi && k > i + 1) {
        if (i > plain) escPush(out, s.slice(plain, i));
        out.push('<code>');
        escPush(out, s.slice(i + 1, k));
        out.push('</code>');
        i = k + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (which === 3) {
      if (i + 1 < hi && s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, hi);
        if (k !== -1 && k > i + 2) {
          if (i > plain) escPush(out, s.slice(plain, i));
          out.push('<strong>');
          inlineRange(s, i + 2, k, out, linkFn);
          out.push('</strong>');
          i = k + 2;
          plain = i;
        } else i += 2;
      } else {
        const k = findSingleStar(s, i + 1, hi);
        if (k !== -1 && k > i + 1) {
          if (i > plain) escPush(out, s.slice(plain, i));
          out.push('<em>');
          inlineRange(s, i + 1, k, out, linkFn);
          out.push('</em>');
          i = k + 1;
          plain = i;
        } else i++;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', i + 1, hi);
    const m = (k !== -1 && k + 1 < hi && s[k + 1] === '(') ? s.indexOf(')', k + 2) : -1;
    const mm = (m !== -1 && m < hi) ? m : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (mm !== -1 && target !== '' && !WS_RE.test(target)) {
      if (i > plain) escPush(out, s.slice(plain, i));
      out.push('<a href="');
      escPush(out, linkFn(target));
      out.push('">');
      inlineRange(s, i + 1, k, out, linkFn);
      out.push('</a>');
      i = mm + 1;
      plain = i;
    } else i++;
  }
  if (hi > plain) escPush(out, s.slice(plain, hi));
}

function renderMarkdown(src, linkFn) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  const para = () => {
    const body = [trimST(lines[i])];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const txt = body.join('\n');
    if (excerpt === null) {
      const tmp = [];
      inlineRange(txt, 0, txt.length, tmp, linkFn);
      const html = tmp.join('');
      excerpt = html;
      out.push('<p>', html, '</p>\n');
    } else {
      out.push('<p>');
      inlineRange(txt, 0, txt.length, out, linkFn);
      out.push('</p>\n');
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.length > 0) {
      const c0 = line.charCodeAt(0);
      // A line opening on a letter or other punctuation can only be a
      // paragraph: no block marker starts with it. Skip every block check.
      if (!(c0 === 35 || c0 === 96 || c0 === 45 || c0 === 42 || c0 === 62 || (c0 >= 48 && c0 <= 57) || c0 === 32 || c0 === 9)) {
        para();
        continue;
      }
    }
    if (isBlank(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      out.push('<pre><code');
      if (lang !== '') { out.push(' class="language-'); out.push(escapeHtml(lang)); out.push('"'); }
      out.push('>');
      while (i < lines.length && !fenceClose(lines[i])) { escPush(out, lines[i]); out.push('\n'); i++; }
      i++;
      out.push('</code></pre>\n');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      if (hd.depth === 2 || hd.depth === 3) {
        const tmp = [];
        inlineRange(hd.text, 0, hd.text.length, tmp, linkFn);
        const html = tmp.join('');
        out.push('<h', String(hd.depth), ' id="', id, '">', html, '</h', String(hd.depth), '>\n');
        toc.push({ level: hd.depth, id, html });
      } else {
        out.push('<h', String(hd.depth), ' id="', id, '">');
        inlineRange(hd.text, 0, hd.text.length, out, linkFn);
        out.push('</h', String(hd.depth), '>\n');
      }
      i++;
      continue;
    }
    if (isHR(line)) { out.push('<hr>\n'); i++; continue; }
    if (line[0] === '>') {
      const body = [];
      while (i < lines.length && lines[i][0] === '>') {
        let l = lines[i++];
        l = l.length > 1 && l[1] === ' ' ? l.slice(2) : l.slice(1);
        body.push(trimST(l));
      }
      const filtered = body.filter((l) => l !== '');
      if (filtered.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const txt = filtered.join('\n');
        out.push('<blockquote>\n<p>');
        inlineRange(txt, 0, txt.length, out, linkFn);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    // List?
    let bullet = false;
    let orderedNum = -1;
    if (line.length >= 2 && (line[0] === '-' || line[0] === '*') && line[1] === ' ') bullet = true;
    else {
      let d = 0;
      while (d < line.length && d < 9 && line[d] >= '0' && line[d] <= '9') d++;
      if (d >= 1 && d < line.length && line[d] === '.' && line[d + 1] === ' ') orderedNum = Number(line.slice(0, d));
    }
    if (bullet || orderedNum !== -1) {
      const isOrdered = orderedNum !== -1;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        let content = null;
        if (!isOrdered && l.length >= 2 && (l[0] === '-' || l[0] === '*') && l[1] === ' ') content = l.slice(2);
        else if (isOrdered) {
          let d = 0;
          while (d < l.length && d < 9 && l[d] >= '0' && l[d] <= '9') d++;
          if (d >= 1 && d < l.length && l[d] === '.' && l[d + 1] === ' ') content = l.slice(d + 2);
        }
        if (content !== null) { items.push(trimST(content)); i++; }
        else if (l.length >= 3 && l[0] === ' ' && l[1] === ' ' && !isWS(l.charCodeAt(2))) {
          items[items.length - 1] += '\n' + trimST(l);
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      if (isOrdered && orderedNum !== 1) out.push('<ol start="', String(orderedNum), '">\n');
      else out.push('<', tag, '>\n');
      for (const item of items) {
        out.push('<li>');
        inlineRange(item, 0, item.length, out, linkFn);
        out.push('</li>\n');
      }
      out.push('</', tag, '>\n');
      continue;
    }
    // Paragraph (anything that was none of the blocks above).
    para();
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates
class TemplateError extends Error {}
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
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
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}
function lk1(S, a) {
  for (let i = S.length - 1; i >= 0; i--) {
    if (Object.hasOwn(S[i], a)) return S[i][a];
  }
  return undefined;
}
function lk2(S, a, b) {
  const v = lk1(S, a);
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  return v[b];
}
function lk3(S, a, b, c) {
  const v = lk2(S, a, b);
  if (v === undefined || v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return undefined;
  return v[c];
}
function lk4(S, a, b, c, d) {
  const v = lk3(S, a, b, c);
  if (v === undefined || v === null || typeof v !== 'object' || !Object.hasOwn(v, d)) return undefined;
  return v[d];
}
function lkA(S, parts) {
  let v = lk1(S, parts[0]);
  for (let k = 1; k < parts.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, parts[k])) return undefined;
    v = v[parts[k]];
  }
  return v;
}

function compileNodes(nodes) {
  let uid = 0;
  let code = '';
  const lkCall = (path) => {
    if (path.length === 1) return `lk1(S,${JSON.stringify(path[0])})`;
    if (path.length === 2) return `lk2(S,${JSON.stringify(path[0])},${JSON.stringify(path[1])})`;
    if (path.length === 3) return `lk3(S,${JSON.stringify(path[0])},${JSON.stringify(path[1])},${JSON.stringify(path[2])})`;
    if (path.length === 4) return `lk4(S,${JSON.stringify(path[0])},${JSON.stringify(path[1])},${JSON.stringify(path[2])},${JSON.stringify(path[3])})`;
    return `lkA(S,${JSON.stringify(path)})`;
  };
  const gen = (ns) => {
    for (const n of ns) {
      if (n.kind === 'text') code += `out.push(${JSON.stringify(n.text)});`;
      else if (n.kind === 'var') code += `out.push(esc(txt(${lkCall(n.path)})));`;
      else if (n.kind === 'raw') code += `out.push(txt(${lkCall(n.path)}));`;
      else if (n.kind === 'if') {
        code += `if(ty(${lkCall(n.path)})!==${n.not ? 'true' : 'false'}){`;
        gen(n.then);
        code += '}';
        if (n.else !== null) { code += 'else{'; gen(n.else); code += '}'; }
      } else if (n.kind === 'for') {
        const id = uid++;
        code += `{const _x${id}=${lkCall(n.path)};if(Array.isArray(_x${id})){const _v${id}={};const _l${id}={index:0,first:false,last:false,length:_x${id}.length};for(let _k${id}=0;_k${id}<_x${id}.length;_k${id}++){_v${id}[${JSON.stringify(n.name)}]=_x${id}[_k${id}];_v${id}.loop=_l${id};_l${id}.index=_k${id}+1;_l${id}.first=_k${id}===0;_l${id}.last=_k${id}===_x${id}.length-1;S.push(_v${id});`;
        gen(n.body);
        code += `S.pop();}}}`;
      } else if (n.kind === 'include') {
        const id = uid++;
        code += `{const _t${id}=G(${JSON.stringify(n.name)});if(_t${id}!==undefined&&depth<8)_t${id}(out,S,depth+1,G,esc,txt,lk1,lk2,lk3,lk4,lkA,ty);}`;
      }
    }
  };
  gen(nodes);
  return new Function('out', 'S', 'depth', 'G', 'esc', 'txt', 'lk1', 'lk2', 'lk3', 'lk4', 'lkA', 'ty', code);
}

// Free variables of a template's AST: first names its paths read, minus names
// bound by enclosing fors ('loop' is bound by every for). Includes read
// their target's free variables, minus the names bound at the include site.
// Used only to spot templates whose output cannot vary within a case.
function freeVars(nodes, bound, memo) {
  const out = new Set();
  const walk = (ns, b) => {
    for (const n of ns) {
      if (n.kind === 'text') continue;
      if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
        if (!b.has(n.path[0])) out.add(n.path[0]);
        if (n.kind === 'if') {
          walk(n.then, b);
          if (n.else !== null) walk(n.else, b);
        }
      } else if (n.kind === 'for') {
        if (!b.has(n.path[0])) out.add(n.path[0]);
        const b2 = new Set(b);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2);
      } else if (n.kind === 'include') {
        const sub = memo.get(n.name);
        if (sub !== undefined) for (const v of sub) if (!b.has(v)) out.add(v);
      }
    }
  };
  walk(nodes, bound);
  return out;
}
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// ---------------------------------------------------------------- Build
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function run(input) {
  slugCache = new Map();
  const report = [];
  const ast = new Map();
  const compiled = Object.create(null);
  for (const name of Object.keys(input.templates).sort()) {
    try {
      ast.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Templates that only read site/tags/recent render the same on every page
  // of this case: cache their first render (at a shallow depth, so no
  // include-depth cutoff can be baked into the cached string).
  const freeMemo = new Map();
  for (const name of ast.keys()) freeMemo.set(name, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of ast) {
      const s = freeVars(nodes, new Set(), freeMemo);
      if (!setsEqual(s, freeMemo.get(name))) { freeMemo.set(name, s); changed = true; }
    }
  }
  const staticSet = new Set();
  for (const [name, s] of freeMemo) {
    let ok = true;
    for (const v of s) if (v !== 'site' && v !== 'tags' && v !== 'recent') { ok = false; break; }
    if (ok) staticSet.add(name);
  }
  const staticStr = new Map();
  const staticWrap = new Map();
  // Templates with exactly one free variable (and it is not 'loop', whose
  // object is reused and mutated by the for that binds it) render as a
  // function of that one value: memoise them by the value's identity.
  // A card, for example, is rendered once per post on the index page and
  // again on each of its tag pages, with the same card object each time.
  const singleVar = new Map();
  for (const [name, s] of freeMemo) {
    if (s.size === 1) {
      const v = [...s][0];
      if (v !== 'loop' && !staticSet.has(name)) singleVar.set(name, v);
    }
  }
  const memoCache = new Map();
  const getTpl = (name) => {
    let f = compiled[name];
    if (f === undefined && ast.has(name)) {
      f = compileNodes(ast.get(name));
      compiled[name] = f;
    }
    if (f === undefined) return f;
    if (staticSet.has(name)) {
      let w = staticWrap.get(name);
      if (w === undefined) {
        w = (out, S, depth, G, esc, txt, lk1, lk2, lk3, lk4, lkA, ty) => {
          if (depth > 1) { f(out, S, depth, G, esc, txt, lk1, lk2, lk3, lk4, lkA, ty); return; }
          let s = staticStr.get(name);
          if (s === undefined) {
            const tmp = [];
            f(tmp, S, depth, G, esc, txt, lk1, lk2, lk3, lk4, lkA, ty);
            s = tmp.join('');
            staticStr.set(name, s);
          }
          out.push(s);
        };
        staticWrap.set(name, w);
      }
      return w;
    }
    const vname = singleVar.get(name);
    if (vname !== undefined) {
      let w = staticWrap.get(name);
      if (w === undefined) {
        w = (out, S, depth, G, esc, txt, lk1, lk2, lk3, lk4, lkA, ty) => {
          if (depth > 1) { f(out, S, depth, G, esc, txt, lk1, lk2, lk3, lk4, lkA, ty); return; }
          const key = lk1(S, vname);
          let cache = memoCache.get(name);
          if (cache === undefined) { cache = new Map(); memoCache.set(name, cache); }
          let s = cache.get(key);
          if (s === undefined) {
            const tmp = [];
            f(tmp, S, depth, G, esc, txt, lk1, lk2, lk3, lk4, lkA, ty);
            s = tmp.join('');
            cache.set(key, s);
          }
          out.push(s);
        };
        staticWrap.set(name, w);
      }
      return w;
    }
    return f;
  };
  const base = input.site.base_url.replace(/\/+$/, '');
  const siteObj = { title: input.site.title, base_url: base };

  // 1. Sources, sorted by path in code-unit order.
  const sortedFiles = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of sortedFiles) {
    if (f.path.endsWith('.md')) {
      // Most sources hold no '\r': skip the regex replace (and the copy
      // it builds) unless one is present.
      const raw = f.content;
      sources.push({ path: f.path, text: raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw });
    } else statics.push(f);
  }

  // 2. Front matter, in order: refused, generator's own dir, post needs date,
  // layout missing, then draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!ast.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // 3. Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  // The same relative targets recur across sources (a handful of
  // neighbours and statics): resolve each (directory, target) once. A
  // broken target still records its own source's broken-link line, so
  // the cache only skips the resolution, never the report entry.
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const linkFn = (target) => {
      if (SCHEME_RE.test(target) || target[0] === '/' || target[0] === '#') return target;
      const key = dir + '\0' + target;
      const hit = linkCache.get(key);
      if (hit !== undefined) {
        if (hit === false) broken.add(`broken-link ${s.path} -> ${target}`);
        return hit === false ? target : hit;
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      let path;
      if (rel === '') path = null;
      else if (rel !== '.' && rel.indexOf('..') === -1 && !rel.startsWith('./') && !rel.includes('/./')
        && !rel.endsWith('/.') && rel.indexOf('//') === -1 && !rel.endsWith('/')) {
        // No '.' or '..' segment and no empty segment: plain join.
        path = dir === '' ? rel : `${dir}/${rel}`;
      } else path = resolvePathParts(dirParts, rel);
      let resolved;
      if (path !== null && bySource.has(path)) resolved = bySource.get(path).url + frag;
      else if (path !== null && staticPaths.has(path)) resolved = `${base}/${path}${frag}`;
      else {
        broken.add(`broken-link ${s.path} -> ${target}`);
        linkCache.set(key, false);
        return target;
      }
      linkCache.set(key, resolved);
      return resolved;
    };
    const md = renderMarkdown(s.body, linkFn);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = [];
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (!seen.includes(slug)) { seen.push(slug); out.push(name); }
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
        tag.triple = { name, slug, url: tag.url };
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
      const hit = bySlug.get(slug);
      if (hit !== undefined) return hit;
      const synth = { name, slug, url: '', posts: [] };
      synth.triple = { name, slug, url: '' };
      return synth;
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const output = {};
  // Cards and page objects, built once per source.
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title, url: s.url, date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  for (const s of kept) {
    const dateLong = s.data.date === undefined ? '' : longDate(s.data.date);
    s.card = {
      title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: dateLong,
      summary: s.data.summary ?? '', excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
      tags: s.tagRefs.map((t) => t.triple),
    };
    s.pageObj = {
      ...s.card, slug: s.slug, content: s.html, toc: s.toc,
      newer: s.post ? linkOf(s.newer) : null, older: s.post ? linkOf(s.older) : null, is_post: s.post,
    };
  }
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  // Reuse one output array and one scope array across renders (renders are
  // synchronous and sequential; for-loops restore the scope stack).
  const renderOut = [];
  const renderScope = [null];
  const rootVars = { site: siteObj, tags: allTags, recent };
  const render = (name, vars) => {
    const fn = getTpl(name);
    if (fn === undefined) return null;
    for (const k of Object.keys(vars)) rootVars[k] = vars[k];
    renderScope[0] = rootVars;
    renderScope.length = 1;
    renderOut.length = 0;
    fn(renderOut, renderScope, 0, getTpl, escapeHtml, textOf, lk1, lk2, lk3, lk4, lkA, truthy);
    for (const k of Object.keys(vars)) delete rootVars[k];
    return renderOut.join('');
  };
  for (const s of kept) {
    const html = render(s.layout, { page: s.pageObj });
    if (html !== null) output[`${s.outDir}/index.html`] = html;
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

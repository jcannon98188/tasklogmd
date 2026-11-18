// A tiny frontmatter reader for the import sources (backlog.md task files). It understands the subset
// backlog.md writes: `key: value` lines, inline lists, block lists, quoted scalars and comments. Anything
// more exotic under a key is kept as raw text so it can be carried over verbatim.

export type YValue = string | number | boolean | null | YValue[];

export interface YEntry {
  key: string;
  value: YValue;
  /** The key's lines exactly as written (LF-normalised), continuation lines included. */
  raw: string;
}

export interface Split {
  entries: YEntry[];
  body: string;
}

export const normalizeText = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n');

export function scalar(raw: string): YValue {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function stripComment(v: string): string {
  let quote: string | null = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(v[i - 1]!))) return v.slice(0, i);
  }
  return v;
}

function splitInline(inner: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const c of inner) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ',') {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map((p) => p.trim());
}

/** Splits `---` frontmatter from the body. Returns an error string when the file has no valid frontmatter. */
export function splitFrontmatter(input: string): Split | string {
  const text = normalizeText(input);
  if (!/^---[ \t]*\n/.test(text)) return 'the file does not start with a "---" frontmatter line';
  const lines = text.split('\n');
  const entries: YEntry[] = [];
  let i = 1;
  for (;;) {
    if (i >= lines.length) return 'frontmatter is not closed (no closing "---" line)';
    const line = lines[i]!;
    if (line.trimEnd() === '---') {
      i++;
      break;
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (!m) return `frontmatter line ${i + 1} is not "key: value": ${JSON.stringify(line.slice(0, 60))}`;
    const first = stripComment(m[2] ?? '').trim();
    let j = i + 1;
    const cont: string[] = [];
    while (j < lines.length) {
      const nx = lines[j]!;
      if (nx.trimEnd() === '---') break;
      const indented = /^\s+\S/.test(nx);
      const dash = first === '' && /^-(\s|$)/.test(nx);
      if (indented || dash) {
        cont.push(nx);
        j++;
      } else break;
    }
    let value: YValue;
    if (first.startsWith('[') && first.endsWith(']')) value = splitInline(first.slice(1, -1)).map(scalar);
    else if (first.startsWith('[') || first.startsWith('{')) value = first;
    else if (first === '' && cont.length > 0 && cont.every((c) => /^\s*-(\s|$)/.test(c))) {
      value = cont.map((c) => scalar(stripComment(c.replace(/^\s*-\s*/, ''))));
    } else if (cont.length > 0) value = [m[2] ?? '', ...cont].join('\n').trim();
    else value = scalar(first);
    entries.push({ key: m[1]!, value, raw: [line, ...cont].join('\n') });
    i = j;
  }
  return { entries, body: lines.slice(i).join('\n') };
}

/** Plain text when safe, otherwise a JSON-quoted string (which the native parser reads back exactly). */
export function yamlStr(s: string): string {
  const plain =
    /^[A-Za-z0-9._/][A-Za-z0-9._/ ()+,'-]*$/.test(s) &&
    !/\s$/.test(s) &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(s) &&
    !/^[0-9.+-]+$/.test(s);
  return plain ? s : JSON.stringify(s);
}

export const asList = (v: YValue | undefined): YValue[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Lowercase kebab-case, `[a-z0-9-]` only; '' when nothing usable remains. */
export function slugify(s: string, max = 60): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/g, '');
}

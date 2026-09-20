import parseLinkDestination from 'markdown-it/lib/helpers/parse_link_destination.mjs';

export const NOTE_EXTENSION = /\.(?:md|markdown|mdown|mkdn)$/i;
export function noteTargetPath(path, target) {
  return target === 'html' ? path.replace(NOTE_EXTENSION, '.html') : target === 'quarto' ? path.replace(NOTE_EXTENSION, '.qmd') : path;
}
export function publicationNotePath(note, root, input, extension) {
  const relative = note.slice(root.length).replace(/^\//, '') || note.split('/').at(-1);
  return `${relative.replace(NOTE_EXTENSION, '')}/${input}/document.${extension}`;
}
export function outputAnchor(label) { return label ? `[]{#${encodeURIComponent(String(label))}}` : ''; }

/** Explicit, escaped anchors and deterministic heading IDs; arbitrary raw HTML stays disabled. */
export function notebookMarkdownReferences(markdown) {
  // Recognize only the generated inert live-export wrappers. Raw HTML remains off.
  markdown.block.ruler.before('html_block', 'rix_live_marker', (state, startLine, endLine, silent) => {
    const text = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trim();
    const initial = /^<div class="rix-initial-cell" data-rix-initial-cell="(\d{1,6})">$/.exec(text);
    const live = /^<!--\s*rix-live-cell:(\d{1,6})\s*-->$/.exec(text);
    const closing = text === '</div>' && (state.env.rixInitialDepth || 0) > 0;
    if (!initial && !live && !closing) return false;
    if (silent) return true;
    const token = state.push('rix_live_marker', '', 0); token.block = true;
    if (initial) { state.env.rixInitialDepth = (state.env.rixInitialDepth || 0) + 1; token.content = `<div class="rix-initial-cell" data-rix-initial-cell="${initial[1]}">`; }
    else if (closing) { state.env.rixInitialDepth--; token.content = '</div>'; }
    else token.content = `<div class="rix-live-widget" data-rix-live-cell="${live[1]}"></div>`;
    state.line = startLine + 1; return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  markdown.renderer.rules.rix_live_marker = (tokens, index) => tokens[index].content + '\n';
  markdown.inline.ruler.before('link', 'rix_anchor', (state, silent) => {
    const match = /^\[\]\{#([^\s{}]{1,2048})\}/.exec(state.src.slice(state.pos));
    if (!match) return false;
    let id; try { id = decodeURIComponent(match[1]); } catch { return false; }
    if (!silent) { const token = state.push('rix_anchor', 'span', 0); token.attrSet('id', id); }
    state.pos += match[0].length; return true;
  });
  markdown.renderer.rules.rix_anchor = (tokens, index, options, env, self) => `<span${self.renderAttrs(tokens[index])}></span>`;
  markdown.core.ruler.push('rix_heading_ids', (state) => {
    const used = new Set();
    for (const token of state.tokens) for (const child of token.children || []) if (child.type === 'rix_anchor') used.add(child.attrGet('id'));
    for (let index = 0; index < state.tokens.length; index++) {
      const token = state.tokens[index];
      if (token.type !== 'heading_open' || token.attrGet('id')) continue;
      const text = state.tokens[index + 1]?.content || '';
      const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
      let id = base, suffix = 1; while (used.has(id)) id = `${base}-${suffix++}`;
      token.attrSet('id', id); used.add(id);
    }
  });
}
function resolveNote(current, reference) {
  const parts = current.split('/'); parts.pop();
  for (const part of reference.split('/')) {
    if (part === '..') { if (parts.length <= 1) return null; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
function relativePath(current, target) {
  const from = current.split('/'); from.pop(); const to = target.split('/');
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  return [...from.map(() => '..'), ...to].join('/');
}
/** Rewrite only known note destinations; never fetch, rewrite code, or manufacture omitted pages. */
export function rewriteNotebookLinks(source, { note, destinations, diagnostics = [] }) {
  if (source.length > 4 * 1024 * 1024) throw new Error('Notebook reference source budget exceeded');
  const current = destinations.get(note);
  if (!current) return source;
  function replacement(destination) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(destination)) return null;
    const match = /^([^?#]*)([?#][\s\S]*)?$/.exec(destination);
    let path; try { path = decodeURIComponent(match[1]); } catch { return null; }
    if (!NOTE_EXTENSION.test(path)) return null;
    const resolved = resolveNote(note, path); const target = destinations.get(resolved);
    if (!target) { diagnostics.push({ level: 'warning', code: 'notebook-reference-unavailable', message: `Linked note is outside this export: ${destination}` }); return null; }
    return relativePath(current, target).split('/').map(encodeURIComponent).join('/') + (match[2] || '');
  }
  const edits = []; let fence = null; let inline = null; let offset = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch && (!fence || fenceMatch[1][0] === fence[0])) {
      if (!fence) fence = fenceMatch[1]; else if (fenceMatch[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = null;
      offset += line.length; continue;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) { offset += line.length; continue; }
    for (let pos = 0; pos < line.length; pos++) {
      if (line[pos] === '\\') { pos++; continue; }
      if (line[pos] === '`') {
        const run = /^`+/.exec(line.slice(pos))[0]; if (!inline) inline = run; else if (inline === run) inline = null; pos += run.length - 1; continue;
      }
      if (inline) continue;
      let start = null;
      if (line[pos] === ']' && line[pos + 1] === '(') start = pos + 2;
      else if (line[pos] === ':' && /^ {0,3}\[[^\]]+\]$/.test(line.slice(0, pos))) start = pos + 1;
      if (start === null) continue;
      while (/\s/.test(line[start] || '') && start < line.length) start++;
      const parsed = parseLinkDestination(line, start, line.length);
      if (!parsed.ok) continue;
      const next = replacement(parsed.str);
      if (next !== null) edits.push({ from: offset + start, to: offset + parsed.pos, text: line[start] === '<' ? `<${next}>` : next });
      pos = parsed.pos - 1;
    }
    offset += line.length;
  }
  for (const edit of edits.reverse()) source = source.slice(0, edit.from) + edit.text + source.slice(edit.to);
  return source;
}

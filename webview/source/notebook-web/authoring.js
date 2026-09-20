import { analyzeRixDocument, completionAt, hoverAt, definitionsAt } from '../../../../rix/src/tools/language-service/index.js';
import { lower } from '../../../../rix/src/eval/lower.js';

const MAX_SOURCE = 1024 * 1024;
const MAX_SEGMENTS = 512;
const clamp = (n, size) => Math.max(0, Math.min(Number.isFinite(n) ? n : 0, size));

/** Runtime offsets and line/column locations are relative to the complete cell. */
export function diagnosticForRixError(error, cell) {
  const message = error instanceof Error ? error.message : String(error);
  const code = cell.code ?? cell.expression ?? '';
  let offset = Number.isInteger(error?.offset) ? error.offset : null;
  const location = String(error?.rixLocation || message).match(/line\s+(\d+)[,:]?\s*(?:column|col)\s+(\d+)/i);
  if (offset === null && location) {
    const lines = code.split('\n');
    const line = clamp(Number(location[1]) - 1, lines.length - 1);
    offset = lines.slice(0, line).reduce((n, part) => n + part.length + 1, 0) + clamp(Number(location[2]) - 1, lines[line].length);
  }
  if (offset === null) offset = Number(message.match(/position (\d+)/)?.[1] ?? 0);
  const from = cell.codeStart + clamp(offset, code.length);
  const to = cell.codeStart + clamp(Number.isInteger(error?.endOffset) ? error.endOffset : offset + 1, code.length);
  return { from, to: Math.max(from, to), severity: 'error', message };
}

/** Analysis never evaluates a cell or installs a plugin. A flow group mirrors execution contexts. */
export function createNotebookAuthoringService({ parseDocument, getCatalog }) {
  let cached = null;
  let queryCache = null;
  let catalogCache = null;
  function document(source) {
    source = String(source);
    if (cached?.source === source) return cached;
    queryCache = null;
    if (source.length > MAX_SOURCE) return cached = { source, segments: [], limited: true };
    const parsed = parseDocument(source);
    let group = 0;
    const segments = parsed.nodes.map(({ type, value }) => {
      if (type === 'cell' && value.metadata.execution === 'refresh') group++;
      return { ...value, code: type === 'cell' ? value.code : value.expression, group: type === 'cell' && value.metadata.execution === 'singleton' ? Symbol('singleton') : group };
    });
    return cached = { source, segments: segments.length > MAX_SEGMENTS ? [] : segments, limited: segments.length > MAX_SEGMENTS };
  }
  function context(source, position) {
    const doc = document(source);
    const segment = doc.segments.find((item) => position >= item.codeStart && position <= item.codeStart + item.code.length);
    if (!segment) return null;
    if (queryCache?.segment === segment) return queryCache;
    // Keep document offsets unchanged, including line breaks, but hide prose and other contexts.
    const parts = []; let cursor = 0;
    for (const item of doc.segments.filter((item) => item.group === segment.group)) {
      parts.push(source.slice(cursor, item.codeStart).replace(/[^\n]/g, ' '), item.code);
      cursor = item.codeStart + item.code.length;
      if (cursor < source.length) { parts.push(';'); cursor++; }
    }
    parts.push(source.slice(cursor).replace(/[^\n]/g, ' '));
    const analysis = analyzeRixDocument(parts.join(''));
    const runtime = catalogCache ||= getCatalog();
    analysis.catalog = [...analysis.catalog.filter((entry) => entry.source === 'document'), ...runtime.entries];
    return queryCache = { segment, analysis, runtime };
  }
  return {
    invalidate() { cached = queryCache = catalogCache = null; },
    validate(source) {
      const doc = document(source);
      if (doc.limited) return [{ from: 0, to: 0, severity: 'warning', message: `Notebook authoring limit: at most ${MAX_SOURCE} characters and ${MAX_SEGMENTS} RiX segments; execution has separate limits.` }];
      if (doc.diagnostics) return doc.diagnostics;
      const diagnostics = [];
      for (const cell of doc.segments) {
        const analysis = analyzeRixDocument(cell.code);
        for (const diagnostic of analysis.diagnostics) diagnostics.push({ from: cell.codeStart + diagnostic.range.start, to: cell.codeStart + diagnostic.range.end, severity: diagnostic.severity === 'information' ? 'info' : diagnostic.severity, message: diagnostic.message, source: diagnostic.source });
        if (analysis.ast) try { lower(analysis.ast); } catch (error) { diagnostics.push(diagnosticForRixError(error, cell)); }
      }
      return doc.diagnostics = diagnostics;
    },
    complete(source, position, explicit = false) {
      const current = context(source, position);
      if (!current) return null;
      const before = source.slice(current.segment.codeStart, position);
      const query = before.match(/(?:@_)?[\p{L}_][\p{L}\p{N}_]*$/u)?.[0] || '';
      if (!query && !explicit && !before.endsWith('.')) return null;
      const member = before.match(/\.([\p{L}_][\p{L}\p{N}_]*)\.([\p{L}\p{N}_]*)$/u);
      if (member) {
        const plugin = current.runtime.plugins.find((entry) => entry.mount?.toLowerCase() === member[1].toLowerCase());
        if (plugin) return { from: position - member[2].length, to: position, options: (plugin.exports || []).map((entry) => typeof entry === 'string' ? entry : entry.name).filter((name) => name?.toLowerCase().startsWith(member[2].toLowerCase())).map((name) => ({ label: name, type: 'function', detail: `${plugin.id} · declared export`, info: `Requires loading plugin ${plugin.id}. Completion reads metadata only.` })) };
      }
      const dot = before[before.length - query.length - 1] === '.';
      const analysis = { ...current.analysis, catalog: current.analysis.catalog.filter((entry) => (!dot || entry.source !== 'document') && (entry.source !== 'document' || !entry.range || entry.range.start <= position)) };
      const items = completionAt(analysis, position);
      return { from: items[0]?.range.start ?? position - query.length, to: position, options: items.map((item) => ({ label: item.label, apply: item.insertText, type: ['function', 'variable', 'namespace', 'keyword'].includes(item.kind) ? item.kind : item.kind === 'parameter' ? 'variable' : 'keyword', detail: item.detail, info: item.documentation })) };
    },
    hover(source, position) { const current = context(source, position); return current ? hoverAt(current.analysis, position) : null; },
    definitions(source, position) { const current = context(source, position); return current ? definitionsAt(current.analysis, position) : []; },
  };
}

export function notebookCompletionSource(engine) {
  return (context) => engine.complete(context.state.doc.toString(), context.pos, context.explicit);
}
export function notebookHoverSource(engine) {
  return (view, position) => {
    const result = engine.hover(view.state.doc.toString(), position);
    if (!result) return null;
    return { pos: result.range.start, end: result.range.end, above: true, create() {
      const dom = view.dom.ownerDocument.createElement('div'); dom.className = 'rix-editor-tooltip'; dom.textContent = result.markdown; return { dom };
    } };
  };
}

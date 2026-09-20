import { Integer } from '@ratmath/core';
import { createRixCelWorkbookHost } from '../../../../rix/src/eval/rixcel-host.js';
import { parseRixCelDocument } from '../../../../rix/src/runtime/rixcel-document.js';
import { createRixCelWorkbookDocument, parseRixCelWorkbook } from '../../../../rix/src/runtime/rixcel-workbook.js';
import { createRixCelTensorSheet, materializeRixCelTensorPlane } from '../../../../rix/src/runtime/rixcel-tensor.js';
import { createSheet, createText, isOutputValue } from '../../../../rix/src/runtime/output.js';
import { formatValue } from '../../../../rix/src/eval/format.js';
import { registerAsyncResource } from '../../../../rix/src/runtime/async-runtime.js';
import { REACTIVE_OUTPUT_READ_ENV } from '../../../../rix/src/eval/functions/reactive-bindings.js';

const fail = message => { throw new Error(`Notebook Cel: ${message}`); };
const string = (value, label) => {
  if (value?.type !== 'string' || !value.value.length) fail(`${label} must be nonempty text`);
  return value.value;
};
const text = value => ({ type: 'string', value });
const integer = (value, label) => {
  const n = value instanceof Integer ? Number(value.value) : value;
  if (!Number.isSafeInteger(n) || n < 1) fail(`${label} must be a positive integer`);
  return n;
};
const index = value => {
  if (!Array.isArray(value?.values)) fail('index must be an Array or Tuple');
  return value.values.map(item => integer(item, 'coordinate'));
};

// Only inert option data crosses into document operations.
function plain(value) {
  if (value instanceof Integer) return Number(value.value);
  if (value?.type === 'string') return value.value;
  if (Array.isArray(value?.values)) return value.values.map(plain);
  if (value?.type === 'map') return Object.fromEntries([...value.entries].map(([key, entry]) => [key, plain(entry)]));
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  fail('options must contain only maps, arrays, text, integers or null');
}
function tensorOptions(value) {
  if (value === null) return {};
  if (value?.type !== 'map') fail('tensor options must be a Map');
  const keys = { viewaxes:'viewAxes', slice:'slice', targetstart:'targetStart', targetaxes:'targetAxes' };
  return Object.fromEntries([...value.entries].map(([key, entry]) => {
    const normalized = keys[key.toLowerCase()];
    if (!normalized) fail(`unknown tensor option: ${key}`);
    return [normalized, plain(entry)];
  }));
}

/** A private workbook session: no formula inherits the notebook's context or grants. */
export function createNotebookCelSession(source, documentId = null) {
  if (typeof source !== 'string' || source.length > 8_000_000 || new TextEncoder().encode(source).byteLength > 8_000_000) fail('document text exceeds 8 MB or is not text');
  let record = JSON.parse(source);
  record = record.format === 'rixcel-workbook' ? parseRixCelWorkbook(record)
    : createRixCelWorkbookDocument([{ document: parseRixCelDocument(record) }]);
  const id = documentId ?? record.documents[0].document.id;
  if (!record.documents.some(item => item.document.id === id)) fail(`unknown document: ${id}`);
  const book = createRixCelWorkbookHost(record);
  const base = book.sheet(id);
  const view = Object.create(base);
  view.setFormulaSource = (at, source, assignmentMode = null) => book.edit(id, { type: 'slot:set', index: at, source, assignmentMode: assignmentMode ?? ':=' });
  view.setFormulaSources = edits => book.edit(id, { type: 'slot:batch', edits });
  view.setAxisLabel = (axis, coordinate, label) => book.edit(id, { type: 'view:axis-label', axis, coordinate, label });
  view.setFormula = () => fail('edits require explicit RiX source text');
  view.getFormula = at => text(base.slot(at).source);
  const observations = new Map();
  function observe(key, snapshot, context) {
    let source = observations.get(key);
    if (!source) { source = { snapshot, subscribe: listener => book.subscribe(listener) }; observations.set(key, source); }
    const value = source.snapshot();
    context?.getEnv(REACTIVE_OUTPUT_READ_ENV, null)?.(source, value);
    return value;
  }
  function sheet(options = null) {
    if (options !== null && options?.type !== 'map') fail('Sheet options must be a Map');
    const entries = new Map(options?.entries || []);
    const shape = base.shape;
    const value = (key, fallback) => entries.get(key) ?? fallback;
    const axes = value('viewaxes', null)?.values?.map(item => integer(item, 'view axis')) ?? base.documentView.viewAxes ?? (shape.length === 1 ? [1] : [1, 2]);
    if (axes.length !== Math.min(2, shape.length) || new Set(axes).size !== axes.length || axes.some(axis => axis > shape.length)) fail('invalid view axes');
    const rows = integer(value('rowcount', Math.min(20, shape[axes[0] - 1])), 'row count');
    const columns = integer(value('columncount', axes[1] ? Math.min(8, shape[axes[1] - 1]) : 1), 'column count');
    const rowStart = integer(value('rowstart', 1), 'row start'), columnStart = integer(value('columnstart', 1), 'column start');
    const planes = shape.reduce((total, extent, axis) => axes.includes(axis + 1) ? total : total * extent, 1);
    if (planes > 32 || rows * columns * planes > 1024) fail('Sheet view exceeds 32 planes or 1024 cells; choose a smaller finite view');
    if (rowStart > shape[axes[0]-1] || (axes[1] && columnStart > shape[axes[1]-1])) fail('view start is outside the document');
    entries.set('rowcount', new Integer(BigInt(rows))); entries.set('columncount', new Integer(BigInt(columns)));
    const ranges = shape.map((extent, axis) => {
      const visible = axes.indexOf(axis + 1);
      const start = visible === 0 ? rowStart : visible === 1 ? columnStart : 1;
      const count = visible === 0 ? rows : visible === 1 ? columns : extent;
      return Array.from({ length: Math.min(count, extent-start+1) }, (_, i) => start+i);
    });
    const coordinates = ranges.reduce((all, range) => all.flatMap(at => range.map(n => [...at,n])), [[]]);
    book.materialize(id, coordinates);
    return createSheet([view, { type: 'map', entries }]);
  }
  const methods = new Map();
  const method = (name, impl) => methods.set(name.toUpperCase(), { type: 'method_builtin', name, impl: ([, ...args], context) => impl(args, context) });
  method('Sheet', ([options = null]) => sheet(options));
  method('Get', ([name], context) => { name = string(name, 'export name'); return observe(`get:${name}`, () => book.get(id, name), context); });
  method('View', ([name], context) => { name = string(name, 'export name'); return observe(`view:${name}`, () => { const value = book.get(id, name); return isOutputValue(value) ? value : createText([text(formatValue(value))]); }, context); });
  method('Set', ([at, source]) => { view.setFormulaSource(index(at), string(source, 'formula source')); return null; });
  method('Region', ([name, start, end]) => {
    book.edit(id, { type:'view:region', name:string(name, 'region name'), start:start === null ? null : index(start), end:end === null ? null : index(end) });
    return null;
  });
  method('Format', ([start, end, style]) => {
    if (style?.type !== 'map') fail('format style must be a Map');
    const keys = { numberformat:'numberFormat' };
    const normalized = Object.fromEntries([...style.entries].map(([key, value]) => {
      key = keys[key.toLowerCase()] ?? key;
      let scalar = plain(value);
      if (['bold','italic'].includes(key) && [0,1].includes(scalar)) scalar = scalar === 1;
      return [key, scalar];
    }));
    book.edit(id, { type:'view:format', start:index(start), end:index(end), style:normalized });
    return null;
  });
  method('Materialize', ([tensor, options = null]) => {
    const value = tensor?.type === 'string' ? book.get(id, string(tensor, 'export name')) : tensor;
    const document = book.export().documents.find(entry => entry.document.id === id).document;
    const candidate = materializeRixCelTensorPlane(document, value, tensorOptions(options));
    book.transaction([{ id, document: candidate.document }]);
    return null;
  });
  method('TensorView', ([name, options = null], context) => {
    name = string(name, 'export name');
    const selected = tensorOptions(options);
    if (selected.targetStart || selected.targetAxes) fail('TensorView accepts only viewaxes and slice');
    return observe(`tensor:${name}:${JSON.stringify(selected)}`, () => createRixCelTensorSheet(book.get(id, name), selected), context);
  });
  method('Record', () => text(JSON.stringify(book.export(), null, 2)));
  method('Dispose', () => { book.dispose(); observations.clear(); return null; });
  const handle = { type: 'map', entries: new Map([['document', text(id)]]), _ext: methods };
  return { handle, book, sheet, dispose() { book.dispose(); observations.clear(); } };
}

export function registerNotebookCel(systemContext, runtime, engine, options) {
  let count = 0;
  function acquire(source, document, context) {
    if (++count > 16) fail('at most 16 embedded sessions per notebook run');
    const session = createNotebookCelSession(source, document === undefined ? null : string(document, 'document ID'));
    try { registerAsyncResource(context, session, () => session.dispose()); }
    catch (error) { session.dispose(); throw error; }
    return session.handle;
  }
  systemContext.registerHost('cel', {
    groups: ['Output'],
    impl: ([source, document], context) => acquire(string(source, 'workbook JSON'), document, context),
    doc: 'Embed inert .rixcel/.rixbook JSON in a private exact workbook. Sheet, Get/View named exports, TensorView, Materialize, Format/Region, Set, Record and Dispose are explicit session operations.',
  });
  systemContext.registerHost('celOpen', {
    groups: ['Output', 'Files'],
    concurrency: 'serial', cancellation: 'cooperative',
    impl: async ([path, document], context) => {
      const read = options.readCelDocument ?? engine.readCelDocument;
      if (typeof read !== 'function') fail('this host cannot open external Cel documents; embed JSON with .cel for portable live output');
      const loaded = await read(string(path, 'document path'), { signal: runtime.controller.signal, importStack: options.importStack ?? [] });
      runtime.controller.signal.throwIfAborted();
      if (!loaded || typeof loaded.identity !== 'string') fail('reader must supply document identity');
      const stack = [...(options.importStack ?? []), ...(loaded.importStack ?? [])];
      if (stack.includes(loaded.identity)) fail(`script/document import cycle: ${[...stack, loaded.identity].join(' -> ')}`);
      return acquire(loaded.source, document, context);
    },
    doc: 'Open a host-authorized relative .rixcel or .rixbook file as an isolated session; changes are local until explicitly saved.',
  });
}

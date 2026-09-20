import { expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { createNotebookBundledPluginCatalog } from '../bundled-plugin-catalog.js';
import { createRixNotebookEngine, diagnosticForRixError, disposeNotebookRun } from './rix-engine.js';
import { notebookCompletionSource, notebookHoverSource } from './authoring.js';
const make = () => createRixNotebookEngine({ pluginCatalog: createNotebookBundledPluginCatalog() });
const labels = result => result?.options.map(item => item.label) || [];

test('shared authoring completes declarations across flow cells and inline expressions without running them', () => {
  const engine = make();
  const source = 'Prose radius\n\n```rix\nradius := 3;\n.Error("never evaluate authoring");\n```\n\nThe result is @{ rad }.\n';
  const pos = source.indexOf('rad }') + 3;
  expect(labels(engine.complete(source, pos))).toContain('radius');
  const full = source.replace('rad }', 'radius }');
  expect(engine.definitions(full, full.indexOf('radius }') + 2)[0]?.range.start).toBe(source.indexOf('radius := '));
  expect(engine.complete(source, 7, true)).toBeNull();
  expect(engine.hover(source, pos - 1)?.markdown).toContain('rad');
  const context = new CompletionContext(EditorState.create({ doc: source }), pos, true);
  expect(notebookCompletionSource(engine)(context)).toEqual(engine.complete(source, pos, true));
});

test('singleton and refresh authoring follow distinct execution contexts; catalogs refresh without installing plugins', () => {
  const engine = make();
  const source = '```rix\noldname := 2;\n```\n```rix singleton\nold\n```\n```rix\nold\n```\n```rix refresh\nnewname := 3;\nold\n```';
  const positions = [...source.matchAll(/\nold\n/g)].map(match => match.index + 4);
  expect(labels(engine.complete(source, positions[0]))).not.toContain('oldname');
  expect(labels(engine.complete(source, positions[1]))).toContain('oldname');
  expect(labels(engine.complete(source, positions[2]))).not.toContain('oldname');
  const catalog = createNotebookBundledPluginCatalog();
  let installs = 0;
  catalog.registerInstaller('fixture', () => { installs++; });
  catalog.addMetadata({ id: 'fixture', kind: 'host', groups: [], permissions: [], mount: 'fixture', version: '1.0.0', exports: ['Sample'], description: 'Read metadata only' });
  engine.configure({ pluginCatalog: catalog });
  const query = '```rix\n.Fixture.Sa\n```';
  expect(labels(engine.complete(query, query.indexOf('Sa') + 2))).toEqual(['Sample']);
  expect(installs).toBe(0);
  const system = '```rix\n@_ABS\n```';
  expect(labels(engine.complete(system, system.indexOf('ABS') + 3))).toContain('@_ABS');
});

test('diagnostics preserve parser offsets, runtime line/column locations, and trimmed inline source', async () => {
  const cell = { code: 'first;\nsecond;', codeStart: 30 };
  expect(diagnosticForRixError(Object.assign(new Error('bad'), { offset: 2, endOffset: 5 }), cell)).toMatchObject({ from: 32, to: 35 });
  expect(diagnosticForRixError(Object.assign(new Error('bad'), { rixLocation: 'line 2, column 3' }), cell)).toMatchObject({ from: 39, to: 40 });
  expect(diagnosticForRixError(new Error('bad position 999'), cell).from).toBe(44);
  const engine = make();
  const source = '# Note\n\n```rix\nx := 2;\nmissing + x;\n```\n\nInline @{  missing + 1 }.\n';
  const run = await engine.executeDocumentAsync(source);
  const failures = run.outputStatements.filter(item => item.kind === 'error');
  expect(failures).toHaveLength(2);
  expect(failures[0].diagnostic.from).toBe(source.indexOf('missing'));
  expect(failures[1].diagnostic.from).toBe(source.lastIndexOf('missing'));
  expect(run.outputStatements[0].position).toBe(source.indexOf('x := '));
  const malformed = 'before @{ 1 + } after\n```rix\nx := ;\n```';
  const errors = engine.validate(malformed).filter(item => item.severity === 'error');
  expect(errors).toHaveLength(2);
  expect(errors.every(item => item.from >= 10 && item.to <= malformed.length)).toBe(true);
  await disposeNotebookRun(run); await engine.dispose();
});

test('hover creates inert text and oversized source receives an explicit bounded-analysis diagnostic', () => {
  const engine = make(); const source = '```rix\n@_ABS(1)\n```';
  const view = { state: EditorState.create({ doc: source }), dom: { ownerDocument: { createElement: () => ({}) } } };
  const tooltip = notebookHoverSource(engine)(view, source.indexOf('ABS') + 1);
  expect(tooltip.create().dom.textContent).toContain('ABS');
  expect(tooltip.create().dom.innerHTML).toBeUndefined();
  expect(engine.validate(' '.repeat(1024 * 1024 + 1))[0].message).toContain('authoring limit');
  expect(engine.validate('```rix\n1;\n```\n'.repeat(513))[0].message).toContain('authoring limit');
});

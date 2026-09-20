import { expect, test as bunTest } from 'bun:test';
import { createRixCelDocument, appendRixCelEvent } from '../../../../rix/src/runtime/rixcel-document.js';
import { createRixCelWorkbookDocument } from '../../../../rix/src/runtime/rixcel-workbook.js';
import { createWidgetSession } from '../../../../rix/src/tools/widget-session.js';
import { parseAndEvaluate } from '../../../../rix/src/eval/evaluator.js';
import { formatValue } from '../../../../rix/src/eval/format.js';
import { createRixNotebookEngine, disposeNotebookRun } from './rix-engine.js';
import { createNotebookCelSession } from './cel-embedding.js';
import { createNotebookBundledPluginCatalog } from '../bundled-plugin-catalog.js';

const test = (name, body) => bunTest(name, body, 30000);
function fixture(source = '1/3', shape = [2,2]) {
  const document = appendRixCelEvent(createRixCelDocument({ id: 'data', shape }), { type: 'slot:set', index: shape.map(() => 1), source });
  return JSON.stringify(createRixCelWorkbookDocument([{ document, exports: { total: { source: `grid[${shape.map(() => 1).join(',')}]*3` } } }]));
}
const embed = json => `b := .cel("""${json}""");`;
const notebook = code => `\`\`\`rix\n${code}\n\`\`\``;
const engine = options => createRixNotebookEngine({ pluginCatalog: createNotebookBundledPluginCatalog(), ...options });

test('embedded widgets update only declared exports and dispose subscriptions on rerun', async () => {
  const host = engine();
  const run = await host.executeDocumentAsync(notebook(embed(fixture()) + 'b.View(:total); b.Sheet();'));
  expect(run.outputStatements.some(s => s.kind === 'error')).toBe(false);
  const output = run.outputStatements[1]; const updates = [];
  output.observed.observe(value => updates.push(value.value.value));
  const sheet = run.runs[0].liveOutput.value;
  const widget = createWidgetSession(sheet);
  widget.dispatch({ type: 'sheet:formula', index: [1,1], source: '2/3' });
  expect(updates).toEqual(['2']);
  expect(formatValue(widget.current().cells[0][0].value)).toBe('2/3');
  const rt = run.runtime;
  expect(() => parseAndEvaluate('b.Get(:private);', rt)).toThrow('missing owned export');
  const saved = parseAndEvaluate('b.Record();', rt).value;
  const reopened = createNotebookCelSession(saved);
  expect(formatValue(reopened.book.get('data','total'))).toBe('2'); reopened.dispose();
  expect(() => widget.dispatch({ type: 'sheet:formula', index: [1,1], source: 'grid[1,1]' })).toThrow(/cycle/i);
  expect(formatValue(widget.current().cells[0][0].value)).toBe('2/3');
  await host.executeDocumentAsync(notebook('17;'));
  expect(() => sheet.formulaSheet.get([1,1])).toThrow('disposed');
  widget.dispose(); await host.dispose(); expect(updates).toEqual(['2']);
});

test('Cel sessions cannot capture notebook bindings or load scripts/plugins and imports remain explicit', async () => {
  for (const source of ['secret', '@secret', '.celOpen("note.md")', '.Plugin.Load("linalg")', '.ReadText("secret")']) {
    const host = engine(); const run = await host.executeDocumentAsync(notebook('secret := 9;' + embed(fixture(source)) + 'b.Sheet();'));
    expect(run.outputStatements.some(s => s.kind === 'error')).toBe(true); await host.dispose();
  }
  const host = engine();
  const run = await host.executeDocumentAsync(notebook(embed(fixture()) + embed(fixture()).replaceAll('b :=','c :=') + 'b.Set([1,1],"3"); c.View(:total);'));
  expect(run.runs[0].liveOutput.value.value.value).toBe('1'); await host.dispose();
});

test('sparse large documents materialize only bounded windows and refuse excessive planes', () => {
  const session = createNotebookCelSession(fixture('1/3', [1000000,1000000]));
  const sheet = session.sheet();
  expect(sheet.cells.length).toBe(20); expect(sheet.cells[0].length).toBe(8);
  expect(session.book.work.nodes).toBeLessThan(200);
  expect(() => session.sheet({ type:'map', entries:new Map([['rowcount',10000]]) })).toThrow('1024 cells');
  session.dispose();
  const ranked = createNotebookCelSession(fixture('1/3', [2,2,1000]));
  expect(() => ranked.sheet()).toThrow('32 planes'); ranked.dispose();
});

test('external readers are explicit, cycle checked, cancellable and unavailable in portable live hosts', async () => {
  const host = engine({ readCelDocument: async (_path, { signal }) => { signal.throwIfAborted(); return { source: fixture(), identity: '/course/data.rixbook', importStack: ['/course/note.md'] }; } });
  const run = await host.executeDocumentAsync(notebook('b := .celOpen("data.rixbook"); b.View(:total);'));
  expect(run.runs[0].liveOutput.value.value.value).toBe('1'); await host.dispose();
  for (const options of [{}, { readCelDocument: async () => ({ source: fixture(), identity: '/course/note.md', importStack: ['/course/note.md'] }) }]) {
    const host = engine(options); const run = await host.executeDocumentAsync(notebook('.celOpen("data.rixbook");'));
    expect(run.outputStatements[0].content).toMatch(/cannot open|import cycle/); await host.dispose();
  }
  const controller = new AbortController();
  const cancelled = engine({ readCelDocument: async () => { controller.abort(); return { source: fixture(), identity: '/data.rixbook' }; } });
  await expect(cancelled.executeDocumentAsync(notebook('.celOpen("data.rixbook");'), { signal:controller.signal })).rejects.toThrow();
  await cancelled.dispose();
});

test('inline data rejects executable/accessor syntax and limits session acquisition', async () => {
  expect(() => createNotebookCelSession('({ get format() { throw 1 } })')).toThrow();
  expect(() => createNotebookCelSession(' '.repeat(8_000_001))).toThrow('8 MB');
  expect(() => createNotebookCelSession('é'.repeat(4_000_001))).toThrow('8 MB');
  const host = engine(); const source = Array.from({length:17},(_,i)=>embed(fixture()).replace('b :=',`book${i} :=`)).join('\n');
  const run = await host.executeDocumentAsync(notebook(source));
  expect(run.outputStatements.at(-1).content).toContain('16 embedded sessions');
  await disposeNotebookRun(run); await host.dispose();
});

test('tensor snapshots select finite planes atomically and readonly exports follow workbook edits', async () => {
  const document = appendRixCelEvent(createRixCelDocument({ id:'data', shape:[4,4] }), { type:'slot:set', index:[1,1], source:'1/3' });
  const json = JSON.stringify(createRixCelWorkbookDocument([{ document, exports:{ cube:{ source:'.Shaped.Generate({: 2,2,2 }, idx -> grid[1,1]+idx[1]+10*idx[2]+100*idx[3])' } } }]));
  const host = engine();
  const run = await host.executeDocumentAsync(notebook(embed(json) + 'b.TensorView(:cube, {= slice=[_,_,2] });'));
  expect(run.outputStatements.filter(s => s.kind === 'error').map(s => s.content)).toEqual([]);
  const statement = run.outputStatements.at(-1), initial = run.runs[0].liveOutput.value;
  expect(formatValue(initial.cells[0][0].value)).toBe('211..1/3');
  expect(initial.formulaSheet).toBeNull();
  expect(() => createWidgetSession(initial)).toThrow('requires a Binding or FormulaSheet');
  const firstPlane = parseAndEvaluate('b.TensorView(:cube,{= slice=[_,_,1] });',run.runtime);
  expect(formatValue(firstPlane.cells[0][0].value)).toBe('111..1/3');
  const updates = []; statement.observed.observe(value => updates.push(value));
  parseAndEvaluate('b.Set([1,1],"2/3");', run.runtime);
  expect(formatValue(updates.at(-1).cells[0][0].value)).toBe('211..2/3');
  parseAndEvaluate('b.Materialize(:cube, {= slice=[_,_,1], targetstart=[2,2] });', run.runtime);
  const record = parseAndEvaluate('b.Record();', run.runtime).value;
  const opened = createNotebookCelSession(record);
  expect(formatValue(opened.book.sheet('data').get([2,2]))).toBe('111..2/3');
  opened.dispose();
  expect(() => parseAndEvaluate('b.Materialize(:cube, {= targetstart=[2,2] });', run.runtime)).toThrow(/collision/i);
  expect(parseAndEvaluate('b.Record();', run.runtime).value).toBe(record);
  expect(() => parseAndEvaluate('b.Materialize(:cube, {= targetstart=[4,4] });', run.runtime)).toThrow();
  expect(() => parseAndEvaluate('b.Materialize(:cube, {= slice=[_,_,3] });', run.runtime)).toThrow();
  expect(parseAndEvaluate('b.Record();', run.runtime).value).toBe(record);
  parseAndEvaluate('b.Set([1,1],"1");', run.runtime);
  const saved = createNotebookCelSession(parseAndEvaluate('b.Record();', run.runtime).value);
  expect(formatValue(saved.book.sheet('data').get([2,2]))).toBe('111..2/3');
  saved.dispose();
  const count = updates.length; await host.dispose();
  expect(updates.length).toBe(count);
});

test('Notebook rank-N regions and format layers roundtrip without changing coordinates or values', async () => {
  const host = engine();
  const run = await host.executeDocumentAsync(notebook(embed(fixture('1/3',[2,2,2])) + 'b.Region(:selected,[1,1,2],[2,2,2]); b.Format([1,1,2],[2,2,2],{= background="#f0f0ff", bold=1, numberFormat=:decimal, precision=2 }); b.Sheet({= slice=[_,_,2] });'));
  expect(run.outputStatements.some(s => s.kind === 'error')).toBe(false);
  const saved = parseAndEvaluate('b.Record();', run.runtime).value;
  const reopened = createNotebookCelSession(saved);
  expect(reopened.book.sheet('data').documentView.regions.selected).toEqual({start:[1,1,2],end:[2,2,2]});
  expect(formatValue(reopened.book.sheet('data').get([1,1,1]))).toBe('1/3');
  reopened.dispose();
  expect(() => parseAndEvaluate('b.Region(:broken,[1,1],[2,2]);',run.runtime)).toThrow();
  expect(() => parseAndEvaluate('b.Format([1,1,2],[2,2,2],{= background="url(evil)" });',run.runtime)).toThrow();
  expect(parseAndEvaluate('b.Record();',run.runtime).value).toBe(saved);
  parseAndEvaluate('b.Region(:selected,_,_);',run.runtime);
  const removed = createNotebookCelSession(parseAndEvaluate('b.Record();',run.runtime).value);
  expect(removed.book.sheet('data').documentView.regions.selected).toBeUndefined();
  removed.dispose(); await host.dispose();
});

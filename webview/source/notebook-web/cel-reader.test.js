import { expect, test } from 'bun:test';
import { createNotebookCelReader, CEL_DOCUMENT_MAX_BYTES } from './cel-reader.js';
import { BrowserDocumentStore } from '../../../docshell/src/browser/browser-document-store.js';
import { createZipProject, openZipProject } from '../../../docshell/src/browser/zip-project.js';

test('browser ZIP Cel references resolve relative to each note without ambient files', async () => {
  const zip = createZipProject(new BrowserDocumentStore([
    ['/project/one/data.rixbook', '{"one":1}'], ['/project/two/data.rixcel', '{"two":2}'],
  ]));
  const store = openZipProject(zip);
  const first = createNotebookCelReader({ store, root: '/project', notePath: '/project/one/note.md', host: 'browser' });
  const second = createNotebookCelReader({ store, root: '/project', notePath: '/project/two/note.md', host: 'browser' });
  expect(await first('./data.rixbook')).toEqual({ source: '{"one":1}', identity: '/project/one/data.rixbook', importStack: ['/project/one/note.md'] });
  expect((await second('data.rixcel')).source).toBe('{"two":2}');
  expect((await second('../one/data.rixbook')).identity).toBe('/project/one/data.rixbook');
  await expect(first('absent.rixcel')).rejects.toThrow('Cel workbook unavailable in browser');
  store.dispose();
});

test('Cel reader rejects traversal, URLs, scripts and import cycles before reading', async () => {
  const reads = [];
  const reader = createNotebookCelReader({ store: { readText: async path => { reads.push(path); return '{}'; } }, root: '/project', notePath: '/project/note.md' });
  for (const path of ['../secret.rixcel', '/project/a.rixcel', 'https://example.com/a.rixcel', 'a\\b.rixcel', 'a.rixcel#frag', 'file.js', 'book.rix']) await expect(reader(path)).rejects.toThrow();
  await expect(reader('note.md')).rejects.toThrow('import cycle');
  await expect(reader('data.rixcel', { importStack: ['/project/data.rixcel'] })).rejects.toThrow('import cycle');
  expect(reads).toEqual([]);
  expect((await reader('data.rixcel')).identity).toBe('/project/data.rixcel');
});

test('Cel reader forwards finite binary budget and abort signal to host', async () => {
  const controller = new AbortController(); let options;
  const reader = createNotebookCelReader({ store: { readBinary: async (_, received) => { options = received; return new TextEncoder().encode('{}'); } }, root: '/project', notePath: '/project/note.md' });
  await reader('data.rixbook', { signal: controller.signal });
  expect(options).toEqual({ maxBytes: CEL_DOCUMENT_MAX_BYTES, signal: controller.signal });
  controller.abort();
  await expect(reader('data.rixbook', { signal: controller.signal })).rejects.toThrow();
});

test('Cel reader detects oversized UTF8 data and unavailable host', async () => {
  const reader = createNotebookCelReader({ store: { readText: async () => 'é'.repeat(CEL_DOCUMENT_MAX_BYTES / 2 + 1) }, root: '/project', notePath: '/project/note.md' });
  await expect(reader('data.rixcel')).rejects.toThrow('byte budget');
  await expect(createNotebookCelReader({ host: 'browser Notebook' })('data.rixcel')).rejects.toThrow('unavailable in this browser Notebook');
});

test('Cel example executes through project reader and exports each note against its own directory', async () => {
  const { createRixNotebookEngine, disposeNotebookRun } = await import('./rix-engine.js');
  const { buildNotebookPublication } = await import('./publication-workflow.js');
  const { createNotebookBundledPluginCatalog } = await import('../bundled-plugin-catalog.js');
  const source = await Bun.file(new URL('../../../examples/cel-embedding/Analysis/report.md', import.meta.url)).text();
  const workbook = await Bun.file(new URL('../../../examples/cel-embedding/Analysis/data.rixbook', import.meta.url)).text();
  const store = new BrowserDocumentStore([
    ['/project/Analysis/report.md', source], ['/project/Analysis/data.rixbook', workbook],
    ['/project/Other/report.md', '```rix\nbook := .celOpen("data.rixbook", "report"); book.View("total");\n```'],
    ['/project/Other/data.rixbook', workbook.replaceAll('7/3', '10')],
  ]);
  const engine = createRixNotebookEngine({ pluginCatalog: createNotebookBundledPluginCatalog() });
  let run;
  try {
    run = await engine.executeDocumentAsync(source, { readCelDocument: createNotebookCelReader({ store, root: '/project', notePath: '/project/Analysis/report.md' }) });
    expect(run.outputStatements.filter(statement => statement.kind === 'error')).toEqual([]);
    const publication = await buildNotebookPublication({ notes: ['/project/Analysis/report.md', '/project/Other/report.md'], root: '/project', store, engine, profile: { targets: ['markdown'] } });
    expect(publication.manifest.diagnostics.filter(item => item.level === "error")).toEqual([]);
    expect(publication.ok).toBe(true);
    expect(new TextDecoder().decode(publication.files.get('Analysis/report/default/document.md'))).toContain('2..17/30');
    expect(new TextDecoder().decode(publication.files.get('Other/report/default/document.md'))).toContain('11');
  } finally { await disposeNotebookRun(run); await engine.dispose(); store.dispose(); }
});

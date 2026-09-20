import { expect, test } from 'bun:test';
import MarkdownIt from 'markdown-it';
import { notebookMarkdownReferences, outputAnchor, rewriteNotebookLinks, publicationNotePath } from './document-references.js';
import { notebookExportCapabilities, notebookExportNotice } from './export-capabilities.js';
import { createRixNotebookEngine, disposeNotebookRun } from './rix-engine.js';
import { createNotebookBundledPluginCatalog } from '../bundled-plugin-catalog.js';
import { buildNotebookPublication } from './publication-workflow.js';
import { BrowserDocumentStore } from '../../../docshell/src/browser/browser-document-store.js';
const renderer = () => new MarkdownIt({ html: false }).use(notebookMarkdownReferences);

test('known cross-note destinations retain fragments, queries, spaces and reference-style links without altering code', () => {
  const destinations = new Map([['/course/a.md', 'a/default/document.html'], ['/course/other note.md', 'other note/default/document.html']]);
  const source = '[figure](<other note.md?view=1#fig-unit>)\n[link][ref]\n[ref]: other%20note.md#fig-unit "title"\n`[code](other%20note.md)`\n```rix\n"[code](other%20note.md)";\n```\n[external](https://example.test/other.md)\n[missing](omitted.md)';
  const diagnostics = [];
  const changed = rewriteNotebookLinks(source, { note: '/course/a.md', destinations, diagnostics });
  expect(changed).toContain('<../../other%20note/default/document.html?view=1#fig-unit>');
  expect(changed).toContain('[ref]: ../../other%20note/default/document.html#fig-unit "title"');
  expect(changed).toContain('`[code](other%20note.md)`');
  expect(changed).toContain('"[code](other%20note.md)";');
  expect(changed).toContain('https://example.test/other.md');
  expect(changed).toContain('[missing](omitted.md)');
  expect(diagnostics).toHaveLength(1);
  expect(publicationNotePath('/course/folder/note.markdown', '/course', 'print', 'qmd')).toBe('folder/note/print/document.qmd');
});

test('explicit figure anchors are safe with raw HTML disabled and headings receive stable noncolliding IDs', () => {
  const html = renderer().render(`${outputAnchor('fig-circle')}\n\n# Heading\n\n# Heading\n\n${outputAnchor('x" onmouseover="bad')}\n\n<script>alert(1)</script>`);
  expect(html).toContain('id="fig-circle"');
  expect(html).toContain('id="heading"'); expect(html).toContain('id="heading-1"');
  expect(html).toContain('id="x&quot; onmouseover=&quot;bad"');
  expect(html).not.toContain('<script>');
  expect(renderer().render('`[]{#not-an-anchor}`')).not.toContain('id="not-an-anchor"');
});

test('profile builds preserve figure IDs and rewrite each target path consistently across native and browser render callbacks', async () => {
  const source = '# Figures\n\n```rix\n.Figure({= content=.Text("Exact result"),label="fig-result",caption="A result"});\n```';
  const store = new BrowserDocumentStore([['course/a.md', '[result](b.md#fig-result)'], ['course/b.md', source]]);
  const engine = createRixNotebookEngine({ pluginCatalog: createNotebookBundledPluginCatalog() });
  const result = await buildNotebookPublication({ notes: ['/course/a.md', '/course/b.md'], root: '/course', store, engine, profile: { targets: ['html', 'markdown', 'quarto'], live: true }, renderHtml: (_, source) => renderer().render(source) });
  expect(result.ok).toBe(true);
  const read = path => new TextDecoder().decode(result.files.get(path));
  expect(read('a/default/document.html')).toContain('href="../../b/default/document.html#fig-result"');
  expect(read('a/default/document.qmd')).toContain('../../b/default/document.qmd#fig-result');
  expect(read('b/default/document.html')).toContain('id="fig-result"');
  expect(read('b/default/document.md')).toContain('[]{#fig-result}');
  expect(result.manifest.diagnostics.some(item => item.code === 'notebook-live-unavailable')).toBe(true);
  const live = await buildNotebookPublication({ notes: ['/course/a.md', '/course/b.md'], root: '/course', store, engine, profile: { targets: ['html'], live: true }, renderHtml: (_, source) => renderer().render(source), renderLiveHtml: (_, source) => renderer().render(source), extraAssets: new Map([['assets/runtime.js', 'export {};']]) });
  expect(live.ok).toBe(true);
  expect(new TextDecoder().decode(live.files.get('a/default/document.html'))).toContain('../../b/default/document.html#fig-result');
  expect(live.files.has('a/default/assets/runtime.js')).toBe(true);
  await engine.dispose();
});

test('capabilities never advertise compiler or native permissions in browser exports', () => {
  const browser = notebookExportCapabilities(); const native = notebookExportCapabilities({ host: 'native', liveHtml: true });
  expect(browser).toMatchObject({ liveHtml: false, nativeCompilation: false, nativePluginGrants: false, projectStorage: 'browser-zip' });
  expect(notebookExportCapabilities({ host: 'browser', liveHtml: true }).liveHtml).toBe(false);
  expect(native).toMatchObject({ liveHtml: true, nativeCompilation: false, nativePluginGrants: true });
  expect(notebookExportNotice(browser, { targets: ['html', 'pdf'] })).toContain('pdf compilation is unavailable here');
  expect(notebookExportNotice(native)).toContain('static initial result');
});

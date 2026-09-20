import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rename, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { createTauriDocumentStore } from '../../../docshell/src/tauri-document-store.js';
import { BrowserDocumentStore } from '../../../docshell/src/browser/browser-document-store.js';
import { createZipProject, openZipProject } from '../../../docshell/src/browser/zip-project.js';
import { createRixNotebookEngine, disposeNotebookRun } from './rix-engine.js';
import { createNotebookBundledPluginCatalog } from '../bundled-plugin-catalog.js';
import { createLiveNotebookEngine, liveSourceDocument } from './live-document.js';
import { buildNotebookPublication } from './publication-workflow.js';
import { notebookMarkdownReferences } from './document-references.js';
import { createWidgetSession, formatValue, parseAndEvaluate } from '../../../../rix/src/index.js';
import { registerAsyncResource } from '../../../../rix/src/runtime/async-runtime.js';

const make = () => createRixNotebookEngine({ pluginCatalog: createNotebookBundledPluginCatalog() });
const markdown = new MarkdownIt({ html: false }).use(notebookMarkdownReferences);
const html = (_, source) => markdown.render(source);
const initial = '# Lesson\n\n```rix\namount := 2;\namount/3;\n```\n\nSee [figure](figure.md#fig-exact).';
const edited = initial.replace('amount := 2', 'amount := 5');
const figure = '# Figure\n\n```rix\n.Figure({= content=.Graphics.Graphic([80,60],[.Graphics.Circle([40,30],10)]), label="fig-exact", caption="Exact circle" });\n```';

async function checkHost(store, root, reopen) {
  await store.writeText(`${root}/lesson.md`, initial);
  expect(await store.readText(`${root}/lesson.md`)).toBe(initial);
  await store.writeText(`${root}/lesson.md`, edited);
  await store.writeText(`${root}/figure.md`, figure);
  store = await reopen(store);
  expect(await store.readText(`${root}/lesson.md`)).toBe(edited);
  const engine = make(); const source = await store.readText(`${root}/lesson.md`);
  const run = await engine.executeDocumentAsync(source);
  expect(run.runs[0].liveOutput.content).toBe('1..2/3');
  expect(engine.complete(source, source.indexOf('amount/3') + 3)?.options.some(item => item.label === 'amount')).toBe(true);
  const publication = await buildNotebookPublication({ notes: [`${root}/lesson.md`, `${root}/figure.md`], root, store, engine, renderHtml: html, profile: { targets: ['markdown', 'html', 'quarto', 'pdf'], live: true } });
  expect(publication.ok).toBe(true);
  const page = new TextDecoder().decode(publication.files.get('lesson/default/document.html'));
  expect(page).toContain('1..2/3'); expect(page).toContain('../../figure/default/document.html#fig-exact');
  expect([...publication.files.keys()].some(name => /assets\/[a-f0-9]{64}\.svg$/.test(name))).toBe(true);
  const figurePage = new TextDecoder().decode(publication.files.get('figure/default/document.html'));
  expect(figurePage).toContain('id="fig-exact"');
  expect(publication.manifest.diagnostics.some(item => item.code === 'notebook-target-unavailable')).toBe(true);
  await store.writeText(`${root}/broken.md`, '![missing](missing.png)\n\n```rix\n.Plugin.Load("not-installed");\n```');
  const failed = await buildNotebookPublication({ notes: [`${root}/broken.md`], root, store, engine, renderHtml: html });
  expect(failed.ok).toBe(false);
  expect(failed.manifest.diagnostics.some(item => item.code === 'notebook-image-unavailable')).toBe(true);
  expect(failed.manifest.diagnostics.some(item => item.code === 'notebook-publication-failed' && item.message.includes('not-installed'))).toBe(true);
  const reactive = await engine.executeDocumentAsync('```rix\n$$n := 1;\n$$view := .Text($n);\n$view;\n```');
  const observed = reactive.runs[0].liveOutput.observed; const updates = [];
  const sheet = await engine.executeDocumentAsync('```rix\nmatrix := {:1x2: 1, 2};\n.Sheet(.Bind(matrix));\n```', { isolated: true });
  const widget = createWidgetSession(sheet.runs[0].liveOutput.value);
  observed.observe(value => updates.push(formatValue(value)));
  const evaluate = code => parseAndEvaluate(code, { context: reactive.runtime.context, registry: reactive.runtime.registry, systemContext: reactive.runtime.systemContext });
  evaluate('$n := 2'); expect(updates).toEqual(['2']);
  widget.dispose();
  expect(() => widget.dispatch({ type: 'sheet:set', index: [1, 1], value: 4 })).toThrow('disposed');
  await disposeNotebookRun(sheet); await disposeNotebookRun(reactive); evaluate('$n := 3'); expect(updates).toEqual(['2']);
  await disposeNotebookRun(run); await engine.dispose(); store.dispose?.();
}

test('browser ZIP host opens, edits, saves, reopens, exports and disposes shared output with visible failures', async () => {
  await checkHost(new BrowserDocumentStore(), '/course', async store => openZipProject(createZipProject(store)));
});

test('native DocShell adapter delegates grants and preserves files across the same authoring/export lifecycle', async () => {
  const base = path.resolve(import.meta.dir, '../../../../tmp'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'h2-native-')); let granted = false; const calls = [];
  const check = name => { if (!granted || !name.startsWith(`${root}/`)) throw new Error('Selected directory grant required'); };
  const io = {
    open: async options => { calls.push(options); return root; },
    invoke: async (command, args) => { calls.push([command, args]); if (args.path !== root) throw new Error('Unexpected grant'); granted = true; },
    readTextFile: async name => { check(name); return readFile(name, 'utf8'); },
    writeTextFile: async (name, source) => { check(name); return writeFile(name, source); },
    exists: async name => { check(name); return access(name).then(() => true, () => false); },
    mkdir, readDir: readdir, rename, copyFile: cp, writeFile,
  };
  const store = createTauriDocumentStore(io);
  // Binary asset reads remain a separate existing host adapter; no resolver or grant is manufactured.
  store.readBinary = async name => { check(name); return new Uint8Array(await readFile(name)); };
  try {
    await expect(store.writeText(`${root}/lesson.md`, 'no grant')).rejects.toThrow('grant');
    expect(await store.chooseDirectory({ title: 'Open course' })).toBe(root);
    await store.grantDirectory(root);
    expect(calls).toEqual([{ directory: true, multiple: false, recursive: true, title: 'Open course' }, ['grant_project_access', { path: root }]]);
    await checkHost(store, root, async () => Object.assign(createTauriDocumentStore(io), { readBinary: store.readBinary }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('published live engine awaits ordered host calls and closes async resources on rerun/disposal', async () => {
  const catalog = createNotebookBundledPluginCatalog(); let closed = 0;
  catalog.addMetadata({ id: 'live-fixture', description: 'Live async fixture', kind: 'host', mount: 'liveFixture', exports: [], groups: [], permissions: [] });
  catalog.registerInstaller('live-fixture', ({ systemContext }) => systemContext.registerHost('waitExact', { impl: async ([value], context) => { registerAsyncResource(context, {}, () => { closed++; }); await Promise.resolve(); return value; }, concurrency: 'safe', cancellation: 'cooperative' }));
  const engine = createLiveNotebookEngine({ pluginCatalog: catalog, plugins: ['live-fixture'] });
  const document = liveSourceDocument([{ index: 7, header: 'out', code: '.liveOut(.waitExact(x + 1));' }, { index: 2, header: 'set', code: 'x := .waitExact(1/3);' }]);
  expect(document.indices).toEqual([2, 7]);
  const run = await engine.executeDocumentAsync(document.source, { mode: 'live' });
  expect(run.runs[1].liveOutput.content).toBe('1..1/3');
  await engine.executeDocumentAsync('```rix\n2;\n```', { mode: 'live' }); expect(closed).toBe(2);
  await engine.dispose(); expect(closed).toBe(2);
  expect(() => liveSourceDocument([{ index: 1, code: '1' }, { index: 1, code: '2' }])).toThrow('duplicate');
  expect(() => liveSourceDocument([{ index: 1, code: '```js\nalert(1)' }])).toThrow('source');
  expect(() => liveSourceDocument([{ index: 1, header: '\nout', code: '1' }])).toThrow('source');
});

test('generated live markers survive safe Markdown rendering while hostile near-matches remain inert', () => {
  const source = '<div class="rix-initial-cell" data-rix-initial-cell="3">\n\nInitial exact value: 1/3.\n\n</div>\n\n<!-- rix-live-cell:3 -->\n';
  const rendered = markdown.render(source);
  expect(rendered).toContain('<div class="rix-initial-cell" data-rix-initial-cell="3">');
  expect(rendered).toContain('<p>Initial exact value: 1/3.</p>');
  expect(rendered).toContain('<div class="rix-live-widget" data-rix-live-cell="3"></div>');
  expect(rendered).not.toContain('&lt;div');
  const hostile = markdown.render('<div class="rix-initial-cell" data-rix-initial-cell="3" onclick="bad()">\n\n<script>bad()</script>\n\n<!-- rix-live-cell:x -->');
  expect(hostile).not.toContain('<script>'); expect(hostile).not.toContain('<div');
});

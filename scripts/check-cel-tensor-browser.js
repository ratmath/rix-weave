import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import MarkdownIt from 'markdown-it';
import { createRixCelDocument, appendRixCelEvent } from '../../rix/src/runtime/rixcel-document.js';
import { createRixCelWorkbookDocument } from '../../rix/src/runtime/rixcel-workbook.js';
import { createRixNotebookEngine, renderStaticDocument } from '../webview/source/notebook-web/rix-engine.js';
import { notebookMarkdownReferences } from '../webview/source/notebook-web/document-references.js';
import { createNotebookBundledPluginCatalog } from '../webview/source/bundled-plugin-catalog.js';

// Build the browser and live bundles first; all browser state stays in repository tmp.
const root = path.resolve(import.meta.dir, '../dist-web');
const scratch = path.resolve(import.meta.dir, '../../tmp/c4-notebook-browser');
await mkdir(scratch, { recursive: true });
const liveBundle = path.resolve(process.env.RIX_LIVE_BUNDLE || path.resolve(import.meta.dir, '../../tmp/c4-live/rix-live.js'));
const sheet = appendRixCelEvent(createRixCelDocument({ id: 'data', shape: [4,4] }), { type: 'slot:set', index: [1,1], source: '1/3' });
const json = JSON.stringify(createRixCelWorkbookDocument([{ document: sheet, exports: { cube: { source: '.Shaped.Generate({: 2,2,2 }, idx -> grid[1,1]+idx[1]+10*idx[2]+100*idx[3])' } } }]));
const source = `\`\`\`rix set
b := .cel("""${json}""");
b.Materialize(:cube, {= slice=[_,_,1], targetstart=[2,2] });
b.Region(:snapshot,[2,2],[3,3]);
b.Format([2,2],[3,3],{= background="#eef3ff", bold=1, numberFormat=:decimal, precision=2 });
\`\`\`

\`\`\`rix
b.Sheet();
\`\`\`

\`\`\`rix
b.TensorView(:cube,{= slice=[_,_,2] });
\`\`\``;
const engine = createRixNotebookEngine({ pluginCatalog: createNotebookBundledPluginCatalog() });
const run = await engine.executeDocumentAsync(source, { mode: 'static' });
assert.deepEqual(run.outputStatements.filter(statement => statement.kind === 'error'), []);
const markdown = new MarkdownIt({ html: false }).use(notebookMarkdownReferences);
const initial = markdown.render(renderStaticDocument(run.document, run.runs, run.inlineRuns, { liveCellPlaceholder: true, liveCellIndexes: new Set([1,2]) }));
await engine.dispose();
const payload = value => JSON.stringify({ source: value }).replaceAll('<', '\\u003c');
const html = runtimeSource => `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="rix-live-controls"></div>${initial}<script id="rix-live-document" type="application/json">${payload(runtimeSource)}</script><script type="module" src="/live.js"></script></body></html>`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/live.html') return new Response(html(source), { headers: { 'Content-Type': 'text/html' } });
  if (pathname === '/fallback.html') return new Response(html(source.replace(`.cel("""${json}""")`, '.celOpen("data.rixbook")')), { headers: { 'Content-Type': 'text/html' } });
  if (pathname === '/live.js') return new Response(Bun.file(liveBundle));
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !await Bun.file(file).exists()) return new Response(null, { status: pathname === '/favicon.ico' ? 204 : 404 });
  return new Response(Bun.file(file));
} });
let browser; let activePage; let stage = 'launch';
try {
  const { chromium } = await import(process.env.RIX_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launchPersistentContext(path.join(scratch, `profile-${Date.now()}`), { headless: true, ...(process.env.RIX_CHROME_EXECUTABLE ? { executablePath: process.env.RIX_CHROME_EXECUTABLE } : {}) });
  const page = await browser.newPage(); activePage = page; const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.port}`;
  stage = 'initial browser'; await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#rix-output')?.textContent.includes('28..2/7'));
  stage = 'embed load'; await page.locator('.cm-content').fill(source); await page.locator('#run-notebook').click();
  async function verify(sheetScope, tensorScope) {
    const sheet = page.locator(sheetScope), tensor = page.locator(tensorScope);
    await tensor.locator('td[data-rix-index="1,1"]').waitFor();
    assert.equal((await tensor.locator('td[data-rix-index="1,1"]').innerText()).trim(), '211..1/3');
    assert.equal(await tensor.locator('[data-rix-edit-source]').count(), 0);
    const snapshot = sheet.locator('td[data-rix-index="2,2"]');
    assert.equal((await snapshot.innerText()).trim(), '≈ 111.33');
    assert.equal(await snapshot.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(238, 243, 255)');
    assert.equal(await snapshot.evaluate(el => getComputedStyle(el).fontWeight), '700');
    await sheet.locator('td[data-rix-index="1,1"]').dblclick();
    const input = sheet.locator('[data-rix-edit-source]');
    await input.fill('2/3'); await input.press('Enter');
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.trim() === '211..2/3', `${tensorScope} td[data-rix-index="1,1"]`);
    assert.equal((await snapshot.innerText()).trim(), '≈ 111.33');
    await tensor.locator('td[data-rix-index="1,1"]').dblclick();
    assert.equal(await tensor.locator('[data-rix-edit-source]').count(), 0);
  }
  stage = 'browser tensor edit';
  const sheets = page.locator('#rix-output .rix-output-sheet');
  await sheets.nth(1).waitFor();
  await sheets.nth(0).evaluate(el => el.parentElement.id='editable-sheet');
  await sheets.nth(1).evaluate(el => el.parentElement.id='tensor-sheet');
  await verify('#editable-sheet', '#tensor-sheet');
  await page.screenshot({path:path.join(scratch,'tensor-notebook.png')});
  stage = 'live load'; await page.goto(`${url}/live.html`);
  await page.waitForFunction(() => document.querySelector('[data-rix-initial-cell="1"]')?.hidden);
  stage = 'live tensor edit';
  await verify('[data-rix-live-cell="1"]', '[data-rix-live-cell="2"]');
  await page.screenshot({path:path.join(scratch,'tensor-live.png')});
  assert.deepEqual(errors, []);
  console.log('C4 Notebook browser and live output passed: selected readonly tensor plane updates, fixed exact snapshot, named region and rounded block formatting.');
} catch (error) { console.error('Failed stage:', stage, await activePage?.locator('body').innerText()); throw error; } finally { await browser?.close(); server.stop(true); }

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
const scratch = path.resolve(import.meta.dir, '../../tmp/c3-browser');
await mkdir(scratch, { recursive: true });
const liveBundle = path.resolve(process.env.RIX_LIVE_BUNDLE || path.resolve(import.meta.dir, '../../tmp/c3-live/rix-live.js'));
const sheet = appendRixCelEvent(createRixCelDocument({ id: 'data', shape: [2,2] }), { type: 'slot:set', index: [1,1], source: '1/3' });
const json = JSON.stringify(createRixCelWorkbookDocument([{ document: sheet, exports: { total: { source: 'grid[1,1]*3' } } }]));
const source = `\`\`\`rix set\nb := .cel("""${json}""");\n\`\`\`\n\n\`\`\`rix\nb.Sheet();\n\`\`\`\n\n\`\`\`rix\nb.View(:total);\n\`\`\``;
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
  const output = '#rix-output';
  await page.locator(`${output} td[data-rix-index="1,1"]`).waitFor();
  const view = page.locator(`${output} .cell-result-value`).last();
  assert.equal((await view.innerText()).trim(), '1');
  async function edit(scope, value) {
    await page.locator(`${scope} td[data-rix-index="1,1"]`).dblclick();
    const input = page.locator(`${scope} [data-rix-edit-source]`);
    await input.fill(value); await input.press('Enter');
  }
  stage = 'browser edit'; await edit(output, '2/3');
  await page.waitForFunction(() => [...document.querySelectorAll('#rix-output .cell-result-value')].at(-1)?.textContent.trim() === '2');
  assert.equal((await page.locator(`${output} td[data-rix-index="1,1"]`).innerText()).trim(), '2/3');
  stage = 'browser cycle'; await edit(output, 'grid[1,1]');
  await page.waitForFunction(() => document.querySelector('#rix-output')?.textContent.toLowerCase().includes('cycle'));
  assert.equal((await view.innerText()).trim(), '2');
  assert.equal((await page.locator(`${output} td[data-rix-index="1,1"]`).innerText()).trim(), '2/3');
  // Retain a detached old editor to ensure rerun removed its event subscriptions.
  await page.evaluate(() => { window.__oldCelInput = document.querySelector('#rix-output [data-rix-edit-source]'); });
  await page.locator('#run-notebook').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#rix-output .cell-result-value')].at(-1)?.textContent.trim() === '1');
  await page.evaluate(() => { window.__oldCelInput.value = '99'; window.__oldCelInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  assert.equal((await view.innerText()).trim(), '1');
  stage = 'browser edit'; await edit(output, '2/3');
  await page.waitForFunction(() => [...document.querySelectorAll('#rix-output .cell-result-value')].at(-1)?.textContent.trim() === '2');
  await page.screenshot({ path: path.join(scratch, 'embedded-sheet.png') });
  stage = 'live load'; await page.goto(`${url}/live.html`);
  await page.waitForFunction(() => document.querySelector('[data-rix-initial-cell="1"]')?.hidden);
  const liveSheet = '[data-rix-live-cell="1"]';
  const liveView = '[data-rix-live-cell="2"]';
  assert.equal((await page.locator(liveView).innerText()).trim(), '1');
  stage = 'live edit'; await edit(liveSheet, '2/3');
  await page.waitForFunction(() => document.querySelector('[data-rix-live-cell="2"]')?.textContent.trim() === '2');
  stage = 'live cycle'; await edit(liveSheet, 'grid[1,1]');
  await page.waitForFunction(() => document.querySelector('[data-rix-live-cell="1"]')?.textContent.toLowerCase().includes('cycle'));
  assert.equal((await page.locator(liveView).innerText()).trim(), '2');
  await page.screenshot({ path: path.join(scratch, 'live-sheet.png') });
  stage = 'live fallback'; await page.goto(`${url}/fallback.html`);
  await page.locator('.rix-live-error').first().waitFor();
  assert.equal(await page.locator('[data-rix-initial-cell="1"]').isVisible(), true);
  assert.match(await page.locator('[data-rix-initial-cell="1"]').innerText(), /1\/3/);
  assert.equal((await page.locator('[data-rix-initial-cell="2"]').innerText()).trim(), '1');
  assert.deepEqual(errors, []);
  console.log('C3 browser acceptance passed: editable exact sheet, reactive named export, atomic cycle rejection, rerun cleanup, portable live editing and missing-reader static fallback.');
} catch (error) { console.error('Failed stage:', stage, await activePage?.locator('body').innerText()); throw error; } finally { await browser?.close(); server.stop(true); }

import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import MarkdownIt from 'markdown-it';
import { createRixNotebookEngine, renderStaticDocument } from '../webview/source/notebook-web/rix-engine.js';
import { notebookMarkdownReferences } from '../webview/source/notebook-web/document-references.js';
import { createNotebookBundledPluginCatalog } from '../webview/source/bundled-plugin-catalog.js';

// Build browser and live bundles first; keep acceptance artifacts in the umbrella tmp directory.
const root = path.resolve(import.meta.dir, '../dist-web');
const scratch = path.resolve(import.meta.dir, '../../tmp/h2-browser');
await mkdir(scratch, { recursive: true });
const liveBundle = path.resolve(process.env.RIX_LIVE_BUNDLE || path.resolve(import.meta.dir, '../public/rix-live/rix-live.js'));
const engine = createRixNotebookEngine({ pluginCatalog: createNotebookBundledPluginCatalog() });
const source = '```rix\nn := .slider(0:4, 4, 2);\n.Figure({= content=.Text(n/3), label="fig-value" });\n```';
const run = await engine.executeDocumentAsync(source, { mode: 'static' });
const markdown = new MarkdownIt({ html: false }).use(notebookMarkdownReferences);
const initial = markdown.render(renderStaticDocument(run.document, run.runs, run.inlineRuns, { liveCellPlaceholder: true, liveCellIndexes: new Set([0]) }));
await engine.dispose();
const document = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="rix-live-controls"></div>${initial}<script id="rix-live-document" type="application/json">${JSON.stringify({ source }).replaceAll('<', '\\u003c')}</script><script type="module" src="/live.js"></script></body></html>`;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/live.html') return new Response(document, { headers: { 'Content-Type': 'text/html' } });
  if (pathname === '/live-broken.html') return new Response(document.replace(JSON.stringify({ source }).replaceAll('<', '\\u003c'), JSON.stringify({ source: '```rix\n.Plugin.Load("missing-plugin");\n```' })), { headers: { 'Content-Type': 'text/html' } });
  if (pathname === '/live.js') return new Response(Bun.file(liveBundle));
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !await Bun.file(file).exists()) return new Response(null, { status: pathname === '/favicon.ico' ? 204 : 404 });
  return new Response(Bun.file(file));
} });
let browser;
try {
  const { chromium } = await import(process.env.RIX_PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launchPersistentContext(path.join(scratch, `profile-${Date.now()}`), { headless: true, ...(process.env.RIX_CHROME_EXECUTABLE ? { executablePath: process.env.RIX_CHROME_EXECUTABLE } : {}) });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForFunction(() => document.querySelector('#rix-output')?.textContent.includes('28..2/7'));
  const editor = page.locator('.cm-content');
  await editor.fill('```rix\nradius := 3;\nrad\n```');
  await editor.press('ArrowUp'); await editor.press('End'); await editor.press('Control+Space');
  await page.getByRole('option', { name: /radius/ }).waitFor();
  await editor.press('Escape');
  await editor.fill('```rix\nx := 2;\nmissing + x;\n```'); await page.locator('#run-notebook').click();
  await page.waitForFunction(() => document.querySelector('#rix-output')?.textContent.includes('missing'));
  await page.locator('#rix-output').getByText(/missing/, { exact: false }).last().click();
  assert.ok(await editor.evaluate(element => element.contains(element.ownerDocument.activeElement)));
  assert.deepEqual(await editor.evaluate(element => {
    const selection = element.ownerDocument.getSelection();
    return { line: selection.anchorNode.parentElement.closest('.cm-line')?.textContent, offset: selection.anchorOffset };
  }), { line: 'missing + x;', offset: 0 });
  await page.goto(`http://127.0.0.1:${server.port}/live.html`);
  await page.waitForFunction(() => document.querySelector('[data-rix-initial-cell]')?.hidden);
  assert.equal(await page.locator('#fig-value').count(), 1);
  assert.match(await page.locator('[data-rix-live-cell]').innerText(), /2\/3/);
  await page.locator('input[type=range]').fill('4');
  await page.locator('input[type=range]').dispatchEvent('input');
  await page.waitForFunction(() => document.querySelector('[data-rix-live-cell]')?.textContent.includes('1..1/3'));
  assert.equal(await page.locator('#fig-value').count(), 1);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(scratch, 'live-export.png') });
  await page.goto(`http://127.0.0.1:${server.port}/live-broken.html`);
  await page.locator('.rix-live-error').waitFor();
  assert.equal(await page.locator('[data-rix-initial-cell]').isVisible(), true);
  assert.equal(await page.locator('#fig-value').count(), 1);
  assert.match(await page.locator('.rix-live-error').innerText(), /missing-plugin/);
  assert.deepEqual(errors, []);
  console.log('Notebook H2 browser acceptance passed: completion, precise diagnostic navigation, live initial result, exact slider rerun, stable figure ID, failed-plugin static fallback and clean disposal.');
} finally { await browser?.close(); server.stop(true); }

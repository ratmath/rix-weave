import assert from 'node:assert/strict';
import path from 'node:path';
const root=path.resolve(import.meta.dir,'../dist-web');
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const pathname=new URL(request.url).pathname; const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root+path.sep)||!await Bun.file(file).exists())return new Response(null,{status:pathname==='/favicon.ico'?204:404});return new Response(Bun.file(file));}});
let browser;
try {
 const {chromium}=await import(process.env.RIX_PLAYWRIGHT_MODULE || 'playwright');
 browser=await chromium.launch({headless:true,...(process.env.RIX_CHROME_EXECUTABLE?{executablePath:process.env.RIX_CHROME_EXECUTABLE}:{})});
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.port}/`);await page.waitForFunction(()=>document.querySelector('#rix-output')?.textContent.includes('28..2/7'));
 await page.locator('.cm-content').fill('```rix\n{$:2$ [1/3+2/3, 2^60] };\n```');await page.locator('#run-notebook').click();
 await page.waitForFunction(()=>document.querySelector('#rix-output')?.textContent.includes('1152921504606846976'));
 assert.equal(page.workers().length,2); assert.deepEqual(errors,[]);
 await page.locator('.cm-content').fill('```rix\n{$:2$ [2^50000000,2^50000000] };\n```');await page.locator('#run-notebook').click();
 await page.locator('.cm-content').fill('```rix\n17;\n```');await page.locator('#run-notebook').click();
 await page.waitForFunction(()=>document.querySelector('#rix-output')?.textContent.includes('17'));
 const content=await page.locator('#rix-output').innerText();assert.match(content,/17/);assert.doesNotMatch(content,/50000000/);assert.deepEqual(errors,[]);
 await page.screenshot({path:path.resolve(import.meta.dir,'../../tmp/r2-notebook-async.png')});
 await page.close();console.log('Notebook browser acceptance passed: exact worker result, bounded two-worker pool, rapid rerun stale suppression, clean close.');
} finally {await browser?.close();server.stop(true);}

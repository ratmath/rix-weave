#!/usr/bin/env bun
/** Verify native Notebook profile packaging against the actual compiled browser runtime. */
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir,readFile,writeFile } from "node:fs/promises";
import MarkdownIt from "markdown-it";
import { BrowserDocumentStore } from "../docshell/src/browser/browser-document-store.js";
import { createNotebookBundledPluginCatalog } from "../webview/source/bundled-plugin-catalog.js";
import { createRixNotebookEngine } from "../webview/source/notebook-web/rix-engine.js";
import { buildNotebookPublication } from "../webview/source/notebook-web/publication-workflow.js";
const root=path.resolve(import.meta.dir,".."),directory=path.join(root,"tmp/publication-browser");
const runtime=path.resolve(process.argv[2]||path.join(root,"public/rix-live/rix-live.js"));
const source='# Exact notebook\n\n```rix\nx := .slider(1:5,1,3); .Paragraph(["Radius: ",x]);\n```';
const store=new BrowserDocumentStore([["note.md",source]]),markdown=new MarkdownIt({html:true});
const result=await buildNotebookPublication({notes:["/note.md"],store,engine:createRixNotebookEngine({pluginCatalog:createNotebookBundledPluginCatalog()}),profile:{targets:["html"],live:true},extraAssets:new Map([["assets/rix-live.js",new Uint8Array(await readFile(runtime))]]),renderLiveHtml:(title,body,source,options)=>`<!doctype html><html><body><section id="rix-live-controls" hidden></section>${markdown.render(body).replace(/<!--\s*rix-live-cell:(\d+)\s*-->/g,(_,index)=>`<div data-rix-live-cell="${index}"></div>`)}<script id="rix-live-document" type="application/json">${JSON.stringify({source,...options}).replaceAll("<","\\u003c")}</script><script type="module" src="assets/rix-live.js"></script></body></html>`});
assert.equal(result.ok,true);
for(const[name,data]of result.files){const target=path.join(directory,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,data);}
const pagePath=path.join(directory,"note/default/document.html");
await writeFile(path.join(directory,"note/default/failure.html"),(await readFile(pagePath,"utf8")).replace('src="assets/rix-live.js"','src="assets/missing.js"'));
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){const file=path.resolve(directory,`.${new URL(request.url).pathname}`);return file.startsWith(directory+path.sep)&&await Bun.file(file).exists()?new Response(Bun.file(file)):new Response("Not found",{status:404});}});
let browser;try{
const {chromium}=await import(process.env.RIX_PLAYWRIGHT_MODULE||"playwright");browser=await chromium.launch({headless:true,...(process.env.RIX_CHROME_EXECUTABLE?{executablePath:process.env.RIX_CHROME_EXECUTABLE}:{})});const base=`http://127.0.0.1:${server.port}/note/default/`;
const noJs=await browser.newContext({javaScriptEnabled:false}),staticPage=await noJs.newPage();await staticPage.goto(base+"document.html");assert.match(await staticPage.locator("body").innerText(),/Radius: 3/);
const page=await browser.newPage();await page.goto(base+"document.html");await page.waitForSelector(".rix-live-output");assert.match(await page.locator(".rix-live-output").innerText(),/Radius: 3/);assert.equal(await page.locator("[data-rix-initial-cell]").isVisible(),false);const slider=page.locator("input[type=range]");await slider.focus();await page.keyboard.press("ArrowRight");await page.waitForFunction(()=>document.querySelector(".rix-live-output")?.textContent.includes("Radius: 4"));
await page.goto(base+"failure.html");assert.match(await page.locator("body").innerText(),/Radius: 3/);assert.equal(await page.locator("[data-rix-initial-cell]").isVisible(),true);await page.screenshot({path:path.join(directory,"initial-fallback.png")});console.log("Notebook profile browser acceptance passed: static initial output, local live runtime, slider updates, and startup-failure fallback.");
}finally{await browser?.close();server.stop(true);}

import { expect,test } from "bun:test";
import { mkdirSync,mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,renameSync } from "node:fs";
import path from "node:path";
import { buildNotebookPublication,replaceNotebookPublication } from "./publication-workflow.js";
import { BrowserDocumentStore } from "../../../docshell/src/browser/browser-document-store.js";
import { createNotebookBundledPluginCatalog } from "../bundled-plugin-catalog.js";
import { createRixNotebookEngine } from "./rix-engine.js";
const makeEngine=()=>createRixNotebookEngine({pluginCatalog:createNotebookBundledPluginCatalog()});
const html=(title,source)=>`<html><title>${title}</title><body>${source}</body></html>`;
const decoder=new TextDecoder();
test("Notebook profile matrix preserves prose, exact results, local media and graphics with deterministic manifests",async()=>{
 const store=new BrowserDocumentStore([["course/note.md",'# A note\n\nProse and ![pixel](pixel.png).\n\n```rix\nn/3;\n```\n'],["course/pixel.png",new Uint8Array([1,2,3])]]);
 const opts={notes:["/course/note.md"],root:"/course",store,engine:makeEngine(),profile:{targets:["html","markdown","quarto","pdf"],inputs:{a:"n := 1;",b:"n := 2;"}},renderHtml:html};
 const result=await buildNotebookPublication(opts);expect(result.ok).toBe(true);expect(result.manifest.documents).toHaveLength(2);
 expect(decoder.decode(result.files.get("note/a/document.md"))).toContain("1/3");expect(decoder.decode(result.files.get("note/b/document.md"))).toContain("2/3");expect(decoder.decode(result.files.get("note/a/document.md"))).toContain("Prose");expect(decoder.decode(result.files.get("note/a/document.md"))).not.toContain("n := 1");
 expect([...result.files.keys()].some(key=>/assets\/[a-f0-9]{64}\.png/.test(key))).toBe(true);expect(result.manifest.diagnostics.some(item=>item.code==="notebook-target-unavailable")).toBe(true);expect(result.files.has("note/a/document.pdf.unavailable.txt")).toBe(true);expect(decoder.decode(result.files.get("_quarto.yml"))).toContain("note/a/document.qmd");
 const second=await buildNotebookPublication(opts);expect(second.manifest).toEqual(result.manifest);
});
test("Notebook profile errors/cancellation never yield a publishable partial set and external URLs remain inert",async()=>{
 const store=new BrowserDocumentStore([["course/note.md",'# A note\n\n![external](https://invalid.example/img.png)\n\n```rix\nmissing + 1;\n```']]);
 const options={notes:["/course/note.md"],root:"/course",store,engine:makeEngine(),profile:{targets:["html"]},renderHtml:html};
 const result=await buildNotebookPublication(options);expect(result.ok).toBe(false);expect(result.manifest.diagnostics.some(d=>d.code==="notebook-image-unavailable")).toBe(true);expect(result.manifest.diagnostics.some(d=>d.code==="notebook-publication-failed")).toBe(true);
 const abort=new AbortController();abort.abort();await expect(buildNotebookPublication({...options,signal:abort.signal})).rejects.toThrow();await expect(buildNotebookPublication({...options,profile:{maxJobs:1,targets:["html","markdown"]}})).rejects.toThrow("budget");
});
test("Notebook native replacement keeps prior output on failure and removes stale files only after complete replacement",async()=>{
 const tmp=path.resolve(import.meta.dir,"../../../../tmp");mkdirSync(tmp,{recursive:true});const root=mkdtempSync(path.join(tmp,"notebook-publication-"));const destination=path.join(root,"export");
 const store={exists:async p=>existsSync(p),readText:async p=>readFileSync(p,"utf8"),mkdir:async(p,opts)=>mkdirSync(p,opts),writeFile:async(p,data)=>writeFileSync(p,data),rename:async(a,b)=>renameSync(a,b),remove:async(p,opts)=>rmSync(p,{...opts,force:true})};
 const manifest={schema:"rix.publication-artifacts@1",documents:[]};const result={ok:true,manifest,files:new Map([["manifest.json",JSON.stringify(manifest)],["doc.html","complete"]])};
 try{await replaceNotebookPublication(store,destination,result);writeFileSync(path.join(destination,"stale.txt"),"old");await expect(replaceNotebookPublication(store,destination,result,{beforeReplace:()=>{throw new Error("cancel");}})).rejects.toThrow("cancel");expect(existsSync(path.join(destination,"stale.txt"))).toBe(true);await replaceNotebookPublication(store,destination,result);expect(existsSync(path.join(destination,"stale.txt"))).toBe(false);
 const failing={...store,rename:async(a,b)=>{if(a.includes(".stage-"))throw new Error("disk error");return renameSync(a,b);}};await expect(replaceNotebookPublication(failing,destination,result)).rejects.toThrow("disk error");expect(readFileSync(path.join(destination,"doc.html"),"utf8")).toBe("complete");
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("native live profiles package local runtime assets and preserve visible static output",async()=>{
 const store=new BrowserDocumentStore([["note.md","# Live\n\n```rix\nx := .slider(1:5,1,3); x/3;\n```"]]);let retainedSource;
 const result=await buildNotebookPublication({notes:["/note.md"],store,engine:makeEngine(),profile:{targets:["html"],live:true},renderHtml:html,renderLiveHtml:(title,markdown,source)=>{retainedSource=source;return html(title,markdown);},extraAssets:new Map([["assets/runtime.js","local script"]])});
 expect(result.ok).toBe(true);expect(retainedSource).toContain(".slider");expect(decoder.decode(result.files.get("note/default/document.html"))).toContain("1");expect(result.files.has("note/default/assets/runtime.js")).toBe(true);
});

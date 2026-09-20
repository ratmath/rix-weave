import { createNotebookCelReader } from "./cel-reader.js";
import { rewriteNotebookLinks, publicationNotePath, NOTE_EXTENSION } from "./document-references.js";
/** Host-neutral Notebook profile builds. Complete results are committed by the host. */
import { createPublicationProfile, PUBLICATION_MANIFEST_SCHEMA, PUBLICATION_TARGETS } from "../../../../rix/src/runtime/publication-workflow.js";
import { safePublicationPath, visitPublicationTree, withPublicationPlan, quartoProjectYaml } from "../../../../rix/src/runtime/publication-plan.js";
import { renderGraphicSvg } from "../../../../rix/src/runtime/output.js";
import { formatValue } from "../../../../rix/src/eval/format.js";
import { createRixNotebookEngine, renderStaticDocument, disposeNotebookRun } from "./rix-engine.js";
import { bundleNotebookRun, createNotebookAssetStore } from "./output-assets.js";
const bytes=value=>typeof value==="string"?new TextEncoder().encode(value):value;
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes(value))),byte=>byte.toString(16).padStart(2,"0")).join("");
const basename=path=>path.split("/").at(-1);
const dirname=path=>path.slice(0,path.lastIndexOf("/"))||"/";
const join=(a,b)=>`${a.replace(/\/$/,"")}/${b}`;
function localPath(note,ref,root) {
  const parts=dirname(note).split("/").filter(Boolean);
  for(const part of ref.split("/")){if(part==="..")parts.pop();else if(part&&part!==".")parts.push(part);}
  const path=`/${parts.join("/")}`;
  if(root!=="/"&&!path.startsWith(root.replace(/\/$/,"")+"/"))throw new Error("Image reference leaves the selected project");
  return path;
}
export async function buildNotebookPublication({notes,store,engine,profile:options={},profileName="default",root="/",title="RiX Notebook",signal,renderHtml,renderLiveHtml=null,extraAssets=new Map(),readCelDocumentForNote}) {
  const profile=createPublicationProfile(options,profileName);
  if(!Array.isArray(notes)||!notes.length||notes.length>profile.maxDocuments)throw new Error("Notebook publication document budget exceeded");
  if(notes.length*Object.keys(profile.inputs).length*profile.targets.length>profile.maxJobs)throw new Error("Notebook publication job budget exceeded");
  const isolated=createRixNotebookEngine({pluginCatalog:engine.pluginCatalog,plugins:[...new Set([...(engine.plugins||[]),...profile.plugins])]});
  const files=new Map(),documents=[],diagnostics=[],pages=[];let totalBytes=0;const started=Date.now();
  const put=(path,value)=>{safePublicationPath(path);const data=bytes(value);if(!(data instanceof Uint8Array))throw new Error("Invalid publication asset");if(files.has(path))throw new Error(`Duplicate publication artifact: ${path}`);totalBytes+=data.length;if(totalBytes>profile.maxOutputBytes)throw new Error("Notebook publication output byte budget exceeded");files.set(path,data);};
  for(const note of [...notes].sort())for(const[input,prelude]of Object.entries(profile.inputs)) {
    signal?.throwIfAborted();if(Date.now()-started>profile.maxBuildMs)throw new Error("Notebook publication build time budget exceeded");
    const relative=safePublicationPath(note.slice(root.length).replace(/^\//,"")||basename(note));
    const id=relative.replace(NOTE_EXTENSION,"");const prefix=`${id}/${input}`;const artifacts=[];const jobDiagnostics=[];
    let run;const jobStarted=Date.now();
    try {
      const sourceSize=store.files?.get(note)?.byteLength ?? store.files?.get(note)?.length;
      if(sourceSize>profile.maxSourceBytes)throw new Error("Notebook source byte budget exceeded");
      let source=store.readBinary?new TextDecoder().decode(await store.readBinary(note,{maxBytes:profile.maxSourceBytes,signal})):await store.readText(note);if(bytes(source).length>profile.maxSourceBytes)throw new Error("Notebook source byte budget exceeded");
      // Local Markdown images are copied from the existing project grant. External images become inert text.
      const images=[...source.matchAll(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)];
      for(const match of images){const[syntax,alt,ref]=match;try{
        if(/^(?:[a-z]+:|\/|#)/i.test(ref))throw new Error("External image was retained as text; export does not fetch URLs");
        const filename=localPath(note,ref,root);const size=store.files?.get(filename)?.byteLength ?? store.files?.get(filename)?.length;if(size>16_000_000)throw new Error("Image byte budget exceeded");const data=await store.readBinary(filename,{maxBytes:Math.min(16_000_000,profile.maxOutputBytes),signal});
        if(!(data instanceof Uint8Array)||data.length>16_000_000)throw new Error("Image byte budget exceeded");
        const extension=/\.([a-z0-9]{1,8})$/i.exec(filename)?.[1]||"bin";const asset=`assets/${await digest(data)}.${extension}`;
        if(!files.has(`${prefix}/${asset}`))put(`${prefix}/${asset}`,data);
        source=source.replace(syntax,`![${alt}](${asset})`);
      }catch(error){source=source.replace(syntax,`${alt} (image unavailable: ${ref})`);jobDiagnostics.push({level:"warning",code:"notebook-image-unavailable",message:error.message});}}
      const readCelDocument=readCelDocumentForNote?.(note) ?? createNotebookCelReader({store,notePath:note,root,host:"Notebook publication"});
      const evaluatedSource=prelude?`\`\`\`rix set\n${prelude}\n\`\`\`\n\n${source}`:source;
      run=await (isolated.executeDocumentAsync?.(evaluatedSource,{mode:"static",sliderOverrides:new Map(),signal,readCelDocument})??isolated.executeDocument(evaluatedSource,{mode:"static",sliderOverrides:new Map(),readCelDocument}));
      const failures=run.outputStatements.filter(statement=>statement.kind==="error");if(failures.length)throw new Error(failures.map(failure=>`line ${failure.line}: ${failure.content}`).join("\n"));
      if(Object.keys(profile.plan).length)run={...run,runs:run.runs.map(cell=>cell.staticOutput?.value?.type==="output"?{...cell,staticOutput:{...cell.staticOutput,value:withPublicationPlan(cell.staticOutput.value,{...cell.staticOutput.value.publicationPlan,...profile.plan})}}:cell)};
      const originalAssets=[];const seenAssets=new Set();
      const collectAssets=node=>{if(!node||typeof node!=="object"||seenAssets.has(node))return;seenAssets.add(node);if(node.type==="output"&&node.kind==="asset")originalAssets.push(node.ref);if(Array.isArray(node))node.forEach(collectAssets);else if(node.type==="output"||Object.getPrototypeOf(node)===Object.prototype)Object.values(node).forEach(collectAssets);};
      for(const cell of run.runs)if(cell.metadata.role!=="set")collectAssets(cell.staticOutput?.value);
      run=await bundleNotebookRun(run,{store:createNotebookAssetStore(store,{directory:dirname(note)}),maxTotalBytes:Math.min(profile.maxOutputBytes,64_000_000),signal});
      const assetPaths=Object.fromEntries(run.outputBundle.manifest.entries.flatMap((entry,index)=>entry.status==="resolved"&&originalAssets[index]?[[originalAssets[index],entry.ref]]:[]));
      jobDiagnostics.push(...run.outputBundle.manifest.diagnostics);
      for(const[path,data]of run.outputBundle.files)if(!files.has(`${prefix}/${path}`))put(`${prefix}/${path}`,data);
      const graphics=new Map();for(const cell of run.runs)visitPublicationTree(cell.staticOutput?.value,value=>{if(value.kind==="graphic")graphics.set(value,null);});
      for(const graphic of graphics.keys()){const svg=renderGraphicSvg(graphic,formatValue);const asset=`assets/${await digest(svg)}.svg`;graphics.set(graphic,asset);if(!files.has(`${prefix}/${asset}`))put(`${prefix}/${asset}`,svg);}
      const renderedMarkdown=renderStaticDocument(run.document,run.runs,run.inlineRuns,{graphicReference:value=>graphics.get(value)||formatValue(value)});
      put(`${prefix}/source.rix-output.json`,run.outputBundleJSON);
      for(const target of profile.targets){signal?.throwIfAborted();const filename=`${prefix}/document.${PUBLICATION_TARGETS[target]}`;const destinations=new Map(notes.map(path=>[path,publicationNotePath(path,root,input,PUBLICATION_TARGETS[target])]));const markdown=rewriteNotebookLinks(renderedMarkdown,{note,destinations,diagnostics:jobDiagnostics});
        if(target==="markdown"||target==="text")put(filename,markdown);
        else if(target==="quarto"){put(filename,`---\ntitle: ${JSON.stringify(basename(note))}\nformat: ${profile.plan.profile==="slides"?"revealjs":"html"}\n---\n\n${markdown}`);pages.push({path:filename,title:`${basename(note)} (${input})`});}
        else if(target==="bundle")put(filename,run.outputBundleJSON);
        else if(target==="html"){
          if(profile.live&&renderLiveHtml){const liveIndexes=new Set(run.runs.flatMap((cell,index)=>cell.metadata.role!=="set"?[index]:[]));const liveMarkdown=renderStaticDocument(run.document,run.runs,run.inlineRuns,{graphicReference:value=>graphics.get(value)||formatValue(value),liveCellPlaceholder:true,liveCellIndexes:liveIndexes});put(filename,await renderLiveHtml(basename(note),rewriteNotebookLinks(liveMarkdown,{note,destinations,diagnostics:jobDiagnostics}),evaluatedSource,{assetPaths}));}
          else {if(profile.live)jobDiagnostics.push({level:"warning",code:"notebook-live-unavailable",target,message:"This host exports the initial static result; use CLI live HTML or the native Notebook live exporter for interaction."});put(filename,await renderHtml(basename(note),markdown));}
          for(const[path,data]of extraAssets)if(!files.has(`${prefix}/${path}`))put(`${prefix}/${path}`,data);
        } else {const message=`${target} compilation is unavailable in Notebook. Use a CLI RiX publication build for native targets; complete rendered Markdown follows.`;jobDiagnostics.push({level:"warning",code:"notebook-target-unavailable",target,message});put(`${filename}.unavailable.txt`,`${message}\n\n${markdown}`);}
      }
      if(Date.now()-jobStarted>profile.maxJobMs)throw new Error("Notebook publication job time budget exceeded");
      for(const[path,data]of files)if(path.startsWith(prefix+"/"))artifacts.push({path,bytes:data.length,sha256:await digest(data)});
      documents.push({id,input,source:relative,status:"built",targets:profile.targets,artifacts,diagnostics:jobDiagnostics});
    }catch(error){signal?.throwIfAborted();jobDiagnostics.push({level:"error",code:"notebook-publication-failed",message:error.message});documents.push({id,input,source:relative,status:"failed",targets:profile.targets,artifacts:[],diagnostics:jobDiagnostics});}
    finally{await disposeNotebookRun(run);await isolated.reset?.();}
    diagnostics.push(...jobDiagnostics.map(entry=>({...entry,document:id,input,source:relative})));
  }
  if(pages.length)put("_quarto.yml",quartoProjectYaml(title,pages));
  const manifest={schema:PUBLICATION_MANIFEST_SCHEMA,profile:profile.name,documents,diagnostics};
  put("manifest.json",JSON.stringify(manifest,null,2)+"\n");
  await isolated.dispose?.();
  return {ok:documents.every(document=>document.status==="built"),files,manifest};
}

/** The store only receives complete builds; an owned old tree is restored if replacement fails. */
export async function replaceNotebookPublication(store,destination,result,{signal,beforeReplace}={}) {
  if(!result.ok)throw Object.assign(new Error("Publication failed; previous output was retained"),{manifest:result.manifest});
  signal?.throwIfAborted();const marker=`${destination}/manifest.json`;
  const existed=await store.exists(destination);
  if(existed&&(!await store.exists(marker)||JSON.parse(await store.readText(marker)).schema!==PUBLICATION_MANIFEST_SCHEMA))throw new Error("Refusing to replace a directory not owned by publication");
  const suffix=crypto.randomUUID();const stage=`${destination}.stage-${suffix}`,backup=`${destination}.previous-${suffix}`;let moved=false,committed=false;
  await store.mkdir(stage,{recursive:true});
  try{
    for(const[relative,data]of result.files){signal?.throwIfAborted();safePublicationPath(relative);const target=join(stage,relative);await store.mkdir(dirname(target),{recursive:true});await store.writeFile(target,data);}
    await beforeReplace?.();signal?.throwIfAborted();
    if(existed){await store.rename(destination,backup);moved=true;}
    try{await store.rename(stage,destination);committed=true;}catch(error){if(moved){await store.rename(backup,destination);moved=false;}throw error;}
  }finally{if(await store.exists(stage))await store.remove(stage,{recursive:true});if(committed&&moved&&await store.exists(backup))await store.remove(backup,{recursive:true});}
  return result.manifest;
}

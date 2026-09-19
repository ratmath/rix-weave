import { createNotebookBundledPluginCatalog } from "../bundled-plugin-catalog.js";
import { expect, test } from "bun:test";
import { createRixNotebookEngine, disposeNotebookRun, renderStaticDocument } from "./rix-engine.js";
import { createNotebookAssetStore, bundleNotebookRun, createBoundedBinaryStore } from "./output-assets.js";
import { BrowserDocumentStore } from "../../../docshell/src/browser/browser-document-store.js";
import { createZipProject, openZipProject } from "../../../docshell/src/browser/zip-project.js";
import { fixturePng, fixtureWav, fixtureSource, testPortableBundleHost } from "../../../../rix/tests/helpers/portable-bundle-host.js";
import { decodeOutputBundle } from "../../../../rix/src/runtime/output-assets.js";

testPortableBundleHost("RiX Notebook", options => createRixNotebookEngine(options));

test("Notebook publication packages structured media into a moved ZIP with transcripts and relative paths", async () => {
  const store = new BrowserDocumentStore([["/project/notes/local.png",fixturePng],["/project/notes/generated.png",fixturePng],["/project/notes/voice.wav",fixtureWav]]);
  const engine = createRixNotebookEngine({ pluginCatalog: createNotebookBundledPluginCatalog() });
  const run = engine.executeDocument("# Note\n\n```rix\n" + fixtureSource + "\n```", { mode: "static" });
  try {
    expect(run.outputStatements.every(statement=>statement.kind!=="error")).toBe(true);
    const bundled = await bundleNotebookRun(run,{store:createNotebookAssetStore(store,{directory:"/project/notes"})});
    const markdown = renderStaticDocument(bundled.document,bundled.runs,bundled.inlineRuns);
    expect(markdown).toContain("A spoken explanation"); expect(markdown).toContain("A video explanation");
    expect(markdown).not.toContain("/project/"); expect(markdown).not.toContain("![Video");
    const exported = new BrowserDocumentStore([["/note.md",markdown],["/note.rix-output.json",bundled.outputBundleJSON],...[...bundled.outputBundle.files].map(([name,bytes])=>[`/${name}`,bytes])]);
    const archive = createZipProject(exported);
    store.dispose(); await store.delete("/project");
    const moved = openZipProject(archive);
    const restored = await decodeOutputBundle(await moved.readText("/note.rix-output.json"));
    expect(restored.files.size).toBe(2);
    for (const [relative,bytes] of restored.files) expect(await moved.readBinary(`/${relative}`)).toEqual(bytes);
    const markdownRefs=[...markdown.matchAll(/\]\(<(assets\/[^>]+)>\)/g)].map(match=>match[1]);
    expect(markdownRefs).toHaveLength(3);
    for(const ref of markdownRefs) expect(await moved.exists(ref)).toBe(true);
    moved.dispose(); exported.dispose();
  }finally{disposeNotebookRun(run);}
});

test("Notebook store rejects traversal and oversized binary before reading and honors package/content grants", async () => {
  let reads=0;
  const store={stat:async()=>({size:fixturePng.length}),readBinary:async()=>{reads++;return fixturePng;}};
  const assetStore=createNotebookAssetStore(store,{directory:"/chosen",packages:{images:"/chosen/images"},contentPaths:{[`sha256:${"a".repeat(64)}`]:"local.png"}});
  await expect(assetStore.readAsset("../private")).rejects.toThrow();
  await expect(assetStore.readAsset("local.png",{maxBytes:1})).rejects.toThrow("byte budget");
  expect(reads).toBe(0);
  expect(await assetStore.readAsset("package:images/local.png")).toEqual(fixturePng);
  expect(await assetStore.readAsset(`sha256:${"a".repeat(64)}`)).toEqual(fixturePng);
  expect(reads).toBe(2);
});


test("nested image/recording publications retain media in paragraphs and sections", async () => {
  const engine = createRixNotebookEngine({ pluginCatalog: createNotebookBundledPluginCatalog() });
  const run = engine.executeDocument('```rix\n.Section({= level=1, title="Nested", children=[.Paragraph(["Image: ",.Image(.Asset("local.png","image/png"),"Inline pixel")]),.Audio(.Asset("voice.wav","audio/wav"),"Narration text")] });\n```', {mode:"static"});
  try {
    expect(run.outputStatements.every(statement=>statement.kind!=="error")).toBe(true);
    const store=new BrowserDocumentStore([["/local.png",fixturePng],["/voice.wav",fixtureWav]]);
    const bundle=await bundleNotebookRun(run,{store:createNotebookAssetStore(store)});
    const markdown=renderStaticDocument(bundle.document,bundle.runs,bundle.inlineRuns);
    expect(markdown).toContain("![Inline pixel](<assets/");
    expect(markdown).toContain("Narration text");
  }finally{disposeNotebookRun(run);}
});


test("native bounded reads reject growth and excess before allocation and close handles on cancellation", async () => {
  let closed=0, reads=0, size=2, growth=false;
  const native=createBoundedBinaryStore(async()=>({
    stat:async()=>({isFile:true,size}),
    read:async(buffer)=>{ reads++; if(reads===1){buffer.fill(1);return buffer.length;}return growth?1:null; },
    close:async()=>{closed++;},
  }));
  expect(await native.readBinary("selected/image",{maxBytes:2})).toEqual(new Uint8Array([1,1]));
  expect(closed).toBe(1);expect(reads).toBe(2);
  size=100;reads=0;
  await expect(native.readBinary("selected/image",{maxBytes:2})).rejects.toThrow("byte budget");
  expect(reads).toBe(0);expect(closed).toBe(2);
  size=2;growth=true;
  await expect(native.readBinary("selected/image",{maxBytes:2})).rejects.toThrow("grew");
  expect(closed).toBe(3);
  const abort=new AbortController();
  const cancel=createBoundedBinaryStore(async()=>{abort.abort();return {close:async()=>{closed++;}};});
  await expect(cancel.readBinary("selected/image",{signal:abort.signal})).rejects.toThrow();
  expect(closed).toBe(4);
});

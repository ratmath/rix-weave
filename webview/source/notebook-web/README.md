# RiX Weave Web Surface

`notebook-web/` is the browser-only core of RiX Weave. It has no Tauri,
filesystem, dialog, Git, or macOS imports.

* `../../../docshell/src/contracts.js` defines the narrow `NotebookEngine`,
  `DocumentStore`, and host callback boundaries shared with other editors.
* `rix-engine.js` is the RiX implementation of `NotebookEngine`: it parses
  Markdown/RiX documents, awaits source-ordered evaluation, exposes sliders and
  embedded Cel handles, and produces static publication output. Async runs own
  cancellation and resource disposal; a synchronous embedding API is also available.
* `workbench.js` mounts a standalone CodeMirror editor, result list, and
  Markdown/KaTeX preview in any browser DOM.

The native app is a consumer, not a prerequisite: it uses the same RiX engine
and shared output-widget protocol with a Tauri `DocumentStore` from
`../../../docshell/src/tauri-document-store.js`, then supplies its own richer
project/sidebar, menus, dialogs, recents, Git, export, and editor workbench.
The portable `mountNotebookWeb` workbench is used by the browser host and is
available to other compact hosts.
For a hosted version, replace that store and callbacks with HTTP-backed
implementations; no engine or workbench changes are required.

Add the `whiteboard` flag to an output fence when graphic edits should become
source edits:

````markdown
```rix whiteboard out
.Plugin.Load("geometry");
graph := .geometry.ConstructionGraph([]);
.geometry.AuthoringWorkbench(graph, [])
```
````

Geometry actions then serialize the recipe-complete construction back into
that fence with one CodeMirror transaction. Editor undo restores the source
and diagram together. Several whiteboard cells can coexist: each regenerated
cell receives stable, cell-scoped bindings and action identifiers. A custom
derived node without a serializable recipe fails closed and leaves the source
unchanged.

```js
import { createRixNotebookEngine } from "./notebook-web/rix-engine.js";
import { mountNotebookWeb } from "./notebook-web/workbench.js";

const notebook = mountNotebookWeb({
  engine: createRixNotebookEngine({ pluginCatalog }),
  editorHost: document.querySelector("#editor"),
  preview: document.querySelector("#preview"),
  output: document.querySelector("#results"),
  host: { onDocumentChange(source) { saveDraft(source); } },
});
```

## Host capabilities and examples

Use [the Notebook guide](../../../README.md) for source-order modes, authoring
diagnostics, profiles, host-specific export targets, and build commands. Open
[the Cel embedding project](../../../examples/cel-embedding/README.md) as a ZIP
project to exercise `.celOpen`, exact named exports and read-only tensor views.
A standalone Markdown upload cannot read adjacent `.rixcel`/`.rixbook` files;
embed JSON with `.cel` or upload the project ZIP instead.

Static exports retain initial sheets, figures and exact values. A live exported
page cannot reopen project-local files after download. Native filesystem/plugin
grants are supplied by the native adapter and are never inherited by this
browser core. Reruns and closing the workbench dispose prior owned sessions,
subscriptions and asynchronous resources.

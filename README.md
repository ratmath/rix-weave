# RiX Notebook

RiX Notebook is a native macOS authoring environment for Markdown-first,
executable mathematical documents. A reusable DocShell host manages native and
browser file/window concerns; the RiX WebView provides the editing, execution,
and document-rendering experience.

## Architecture boundaries

The app has an explicit reusable notebook engine and widget layer rather than
treating the Tauri entry point as the language implementation:

```text
DocShell host (native or browser files, menus, storage)
                 │
             DocumentStore
                 │
Host workbench (native or browser editor / preview / project UI)
                 │
NotebookEngine + shared output-widget protocol
```

`webview/source/notebook-web/` contains no Tauri imports. Its RiX adapter parses the
Markdown document model, runs the linear runtime, supplies inline values and
sliders, and creates static publication output. Its compact browser workbench
is used by the browser host; the feature-rich native workbench consumes the
same engine and output-widget protocol. `docshell/` contains both HTML
hosts, the native shell, and portable storage adapters. `docshell.manifest.json`
defines product entrypoints plus visible/editable file types. Root build commands
extract configured HTML into `.docshell-build/` before Vite runs.

RiX-specific code and styling live under `webview/`. See the
[host review](ARCHITECTURE.md), [DocShell guide](docshell/README.md), and
[web-core guide](webview/source/notebook-web/README.md).

### Browser single-file prototype

The browser host is usable without Tauri. It opens either a single Markdown
file or a ZIP archive. A ZIP becomes a virtual project directory with the
same notebook/file sidebar, images and other binary assets preserved, and a
project ZIP download on save. Static project export produces a second ZIP
whose Markdown notes contain rendered RiX output while retaining the original
asset layout. Optional local recovery copies are stored only for single files
through IndexedDB; they are clearly opt-in, can be removed from **Recent**,
and should not be treated as durable storage.

```sh
cd rix-nb
bun run dev:browser
```

Open the printed local URL. `bun run dev:web` is an alias for this browser host. Use `bun run dev` for the
native Tauri app. To inspect the native app's frontend in a plain browser, run
`bun run dev:tauri-webview` and open <http://127.0.0.1:1420>; it cannot open
files because it has no Tauri bridge.

## Current status: authoring and publication

The native application and browser host provide a CodeMirror 6 Markdown editor,
live HTML preview, structured interactive output, project-aware storage, and
static/live publication export. The application runs fenced `rix` blocks and
`@{expression}` inline values in
document order; normal `rix flow` blocks share a notebook context and a `rix singleton` block
starts with a fresh isolated one. A `rix refresh` block starts a fresh context
which becomes the context for subsequent ordinary blocks. Results update live
after a short pause while typing.

RiX results are the default right-hand pane. Each top-level RiX statement is
shown with its source line, and selecting a result returns the editor to that
line. Use the Preview button, `Cmd-P`, or `Cmd-Shift-P` to swap that pane for
the rendered Markdown preview, which includes the current RiX statement results.

### Shaped storage and Matrix values

Notebook uses the same constructors and editor grammar as RiX CLI and Web.
`[1,2;3,4]` and `{:2x2: 1,2;3,4}` are Shaped component storage; their arithmetic
is entrywise. Select `{:2x2: /Matrix/ 1,2;3,4}` or `grid ~!: :Matrix` for matrix
algebra. Printed Matrix values retain that header when reinserted. Mathematical
Vector/Covector/Tensor headers require the linalg plugin and explicit Frames.
See the [Shaped guide](../rix/documentation/eval/objects/shaped.md).

### Notebook controls

RiX Notebook adds a notebook-host `.slider(...)` function; it is not a general
RiX runtime feature. A slider returns an exact RiX number and appears in the results pane.
Moving it re-evaluates the document in source order.

```rix
x := .slider(1:5, 1/10, 3);
area := x^2;
```

The positional form is `(interval, step-or-steps, start)`. A positive integer
second value of 3 or greater means a number of steps; other nonzero exact values
are step sizes. The map form is `.slider({= interval=1:5, step=1/10, start=3})`
or `steps` instead of `step`. Omit arguments for `-10:10`, 20 steps, and a
midpoint start. RiX currently writes `1/10` rather than a leading decimal `.1`.

## Project files

Use **New project** to choose a parent folder and create this portable layout:

```text
Project/
  project.toml
  Notebook/
    notebook.toml
    index.md
  assets/
    right-triangle.svg
```

`project.toml` contains an ordered list of notebook manifests; each
`notebook.toml` contains an ordered list of note paths. The project bar creates,
selects, opens, and saves those files. `Cmd-S` saves the active note.

### Plugins

The notebook has two deliberately separate plugin locations.

- **Bundled, trusted plugins** live in
  `rix-nb/webview/source/bundled-plugin-catalog.js`. Their JavaScript is imported there,
  so it becomes part of the signed/application build. They are exposed in the
  catalog but still load only when named in a configuration file or requested
  with `.Plugin.Load("plugin-id")`.
- **Project-local plugins** live under `Project/plugins/` (subfolders are
  allowed). On opening a note, the desktop app scans only files named
  `*.plugin.rix` and `*.plugin.rix.js`, reads their leading `/** YAML **/`
  manifest, and adds them to the catalog. A project `.plugin.rix` can be
  loaded. A project `.plugin.rix.js` is discoverable but cannot execute: adding
  JavaScript execution requires an explicit bundled-app approval above.

Enable known plugins for every notebook in a project with `project.toml`, or
only for one notebook with its `notebook.toml`. `plugin_dirs` is optional and
is resolved relative to the manifest that declares it; entries from the app’s
**RiX Notebook → Settings…** are scanned first. The standard `Project/plugins/`
directory remains available without configuration.

```toml
plugin_dirs = ["shared-plugins"]
plugins = ["float", "my-rix-plugin"]
```

Settings also lets a user add machine-local plugin directories, choose
automatically loaded plugin IDs, and choose whether JavaScript plugins may run
without confirmation. With that setting off (the default), loading a discovered
JavaScript plugin presents a sheet with its ID, description, and exact source
path. **Load for this session** grants the current catalog; **Always allow**
records that exact path. Plugin scanning never evaluates JavaScript. A plugin
author can exclude an unfinished entry entirely by putting
`ignore: true` in its leading YAML frontmatter; ignored files do not appear in
the catalog or reserve their plugin ID.

The installed approximate-math plugin supplies `.float(x)`,
`.float.Interval(x)`, and the other approximate operations. It is bundled with
the app but disabled by default; put `"float"` in either list or run
`.Plugin.Load("float")` in RiX.

### Developing plugin tutorials

Open a first-party `rix/plugins/<plugin-id>/tutorial.md` directly in RiX
Notebook to enter plugin-tutorial development mode. If that plugin is bundled
in the app, the notebook enables it automatically, reruns edited tutorial cells
in the ordinary live preview, and still permits explicit
`.Plugin.Load("<plugin-id>")` calls in the lesson.

Use **Reload plugins** above the results pane after changing a project-local
`*.plugin.rix` source. The action rescans plugin manifests and RiX source,
creates a fresh catalog, and reruns the notebook. During `bun run dev`, edits
to bundled JavaScript plugins such as `draw` and `plot` are additionally handled
by Vite's module reload. Packaged applications never execute an arbitrary
project-local JavaScript plugin; it must remain an explicitly bundled and
approved installer.

A tutorial whose matching plugin is only proposed remains editable and
previewable, but its code results report that the plugin is unavailable rather
than loading a placeholder implementation.

The preview renders `$inline$`, `$$display$$`, `\\(inline\\)`, and
`\\[display\\]` mathematics with KaTeX. Relative Markdown image paths resolve
from the active note and are served through Tauri's asset protocol, so normal
SVG project assets display in the native preview.

## Static export

Use **Export** (`Cmd-E`) to export the current note, a notebook, or the entire
project as rendered Markdown, standalone static HTML, and/or a Quarto project.
The final ordinary expression in an `out` cell is its default publication
output. Use lazy `.static({; ... })` and `.live({; ... })` blocks to run
mode-specific code in document order; each returns `_` and is not itself an
output. `.out(value)`, `.staticOut(value)`, and `.liveOut(value)` explicitly
choose an output for both pathways or one pathway respectively. Calling an
output command with no argument suppresses that pathway's implicit output:

````markdown
```rix out
root := .slider(0:3, 1, 2);
.static({; root := 1; });
report := .Table(["root"], [[root]]);
```
````

An interactive geometry cell can also use the `whiteboard` flag, for example
````markdown
```rix whiteboard out
.Plugin.Load("geometry");
graph := .geometry.ConstructionGraph([]);
.geometry.AuthoringWorkbench(graph, [])
```
````
Point placement, construction actions, constrained movement, undo, and redo
are then persisted by replacing that fence with canonical RiX construction
source in one editor transaction. Normal editor undo therefore restores both
the previous source and rendered construction. Serialization fails closed for
custom derived nodes that do not provide a portable recipe.

This example uses the slider interactively in live mode and pins `root` to 1
only for the static pathway. Fence roles are `set` (invisible), `out` (results
only, the default), and `edu` (code and results); execution modes are `flow`
(default), `singleton`, `refresh`, and `expensive`.

Each selected target gets its own root: `markdown/`, `html/`, or `quarto/`.
Structured RiX outputs remain structured during export: text, headings,
fragments, and tables become Markdown; graphics become SVG files under that
target's `assets/rix/`; figures reference those assets; mathematical grids are
rendered as display LaTeX arrays, including their horizontal and vertical
rules. The Quarto output is an ordinary project with a `_quarto.yml` and static
`.qmd` pages. A `.Slides(...)` result makes its page a Reveal.js Quarto page.

`examples/export-showcase/` is an openable project that exercises reports,
tables, plots, figures, synthetic division, and slides. Quarto is only needed
to render the generated project, not to create it. With Quarto installed:

```sh
cd chosen-export-folder/quarto
quarto render
```

### Live HTML and Quarto pages

Any `out` or `edu` cell with a live publication output becomes an interactive
widget in standalone HTML and Quarto HTML / Reveal.js targets. The browser bundle is copied to
`assets/rix-live/` only when an export contains a live cell. Cells share a
page-level RiX context, and notebook sliders recompute the live results in
source order.

````markdown
```rix out
parameter := .slider(0:3, 1, 1);
report := .Table(["x", "x²"], [[parameter, parameter^2]]);
```
````

Quarto pages contain both `::: {.rix-static}` and `::: {.rix-live}` sections
for each live cell. The static section remains usable without JavaScript; once
the RiX browser runtime starts, it shows the live section and hides that
fallback. The first live export intentionally ships a compact report widget—
controls, result, and optional source disclosure rather than a full notebook
editor. For a live Quarto page, RiX fences are also woven into the `.qmd` as
ordered `.rix-runtime-source` code blocks. The shared `assets/rix-live/`
harness discovers those blocks and evaluates them as one page-level context,
so the live source remains inspectable and editable in the exported project.
It uses a browser-native module rather than requiring an Observable runtime,
so it works equally in ordinary Quarto HTML pages and Reveal.js. Live grids,
including synthetic division, are rendered by KaTeX from the same LaTeX-array
serializer used by static exports.

## Development setup

The project uses Bun for JavaScript tooling and Tauri 2 for the native macOS
shell. Install these prerequisites once:

1. Xcode Command Line Tools: `xcode-select --install`
2. A stable Rust toolchain, normally with [rustup](https://rustup.rs/)
3. Bun 1.4 or newer

Then, after reviewing `package.json`, install the JavaScript dependencies:

```sh
cd rix-nb
bun install
```

For test feedback, use `bun run test:short`, `bun run test:ten`, and
`bun run test:suite` in increasing order. `bun run test` aliases the complete
suite.

All development and production hosts run `bun run prepare:docshell`
automatically. Run it directly when inspecting the generated HTML build inputs.

The first native build also downloads Rust crates, so it needs network access.
Start the development app with:

```sh
bun run dev
```

Build an unsigned local macOS application with:

```sh
bun run build
```

`bun run dev` is a development command only: it starts Vite's local hot-reload
web server and launches Tauri against it. A packaged RiX Notebook application
contains the prebuilt WebView assets and does not require Bun or Node to run.

Tauri writes development and build artifacts below `src-tauri/target/`; they are
intentionally ignored. A distributable app for other Macs will eventually need
Apple signing and notarization, but neither is required for local development.

## Async execution

Both workbenches await cells and inline values in document order, cancel
superseded runs and close owned async resources. Eligible pure collection
tasks use a bounded local worker pool. The synchronous embedding API remains
available. See [task workers](../rix/documentation/eval/task-workers.md) for
supported captures, budgets and cleanup. After `bun run build:browser`,
`bun scripts/check-async-browser.js` verifies real browser worker execution and
rapid rerun cancellation (set `RIX_PLAYWRIGHT_MODULE` / `RIX_CHROME_EXECUTABLE`
when Playwright or Chrome are installed outside this project).

## Remaining integration work

Reconciled 2026-09-20. The umbrella `ratmath/WORK_PLAN.md` is the execution queue.
H2 authoring and supported host exports are implemented. Remaining integration:
embed RiXCel documents and their explicit named exports (C3), extend runnable
tutorial coverage (H3), and refresh distributed bundles in the final release
verification (Q1). Note references never execute the linked note.

Both editors use the shared RiX language service for completion, hover help,
syntax diagnostics and precise result/error navigation, including inline RiX.
Completion follows flow, singleton and refresh contexts and reads plugin
metadata without installing plugins. Authoring analysis is bounded to 1 MiB
and 512 RiX segments; larger documents receive an explicit diagnostic.

Exports preserve explicit figure/table labels and deterministic heading IDs.
Links to included notes are rewritten for each target, retaining fragments and
queries. Profile builds report links to omitted notes instead of inventing
pages. Generated SVG and portable media assets travel with the publication.

The export dialog describes the actual host capabilities. Browser files and
ZIP projects produce static HTML, Markdown and Quarto source. Native Notebook
also supplies local live HTML with static initial results. Live exports share
the editor's async engine, cancellation and disposal. Filesystem access and
native plugin grants stay behind native adapters. PDF/LaTeX compilation belongs
to the CLI publication build; unsupported profile targets emit diagnostics and
rendered source rather than claiming a successful compilation.

`bun test webview/source/notebook-web` covers shared authoring, real-filesystem
adapter and browser ZIP save/reopen, references/assets, static/live execution,
missing assets/plugins/tools, and resource disposal. Native adapter tests inject
the Tauri API; they do not automate the macOS permission dialog. For Chromium
acceptance, build the browser and live runtime, then run
`bun scripts/check-authoring-browser.js`. It checks editor completion/navigation
and an exported live slider with a stable figure ID. Set `RIX_LIVE_BUNDLE` to
test an isolated live build; the Playwright/Chrome overrides above also apply.

## Design notes

Notebook note references provide document ordering, not source-level inclusion.
If notes later expose reusable definitions, that should use an explicit,
module-like RiX import with named exports and namespaces. That keeps execution
state local to a notebook while making reusable mathematical libraries clear.

Execution results should be live by default. A later per-notebook or per-note
setting can opt into persisting a result cache for soft export/review without
making generated output canonical source.

RiX is bundled into the WebView directly from the sibling `rix` source tree.
The first notebook runtime deliberately does not support RiX filesystem/script
imports; project-aware module imports will be introduced through a constrained
notebook module resolver rather than Node APIs.

The next project-management slice adds Tauri's dialog and filesystem plugins.
These are used only after a user selects a project folder; the application does
not receive a blanket home-directory filesystem scope.

## Portable media in publication exports

Native and browser publication exports resolve structured `Asset`/`Image`/
`Audio`/`Video` values through the shared bounded RiX asset resolver. Files come
from the already selected note directory or uploaded project; no broader path
grant is requested. Exports copy hash-named assets beside each note and write
a `<note>.rix-output.json` sidecar for structured publications. Missing assets
remain readable placeholders with source-path diagnostics; HTTP(S) media stays
a link unless an embedding host explicitly authorizes fetching it. Captions and
transcripts survive static Markdown, HTML, and Quarto exports.

The engine also exposes `exportOutputBundle(value)`/`importOutputBundle(json)`
for host integrations. Imports validate the saved bytes without reopening any
original path or rerunning source. See
`../rix/documentation/eval/output-assets.md` for limits and the versioned format.

## Named publication profiles

Project and notebook manifests support `[export_profiles.NAME]` tables with
`targets`, `plugins`, partial publication `plan`, named RiX `inputs`, and finite
budgets. `default_export_profile` selects the default; notebook profiles override
matching project profiles. Export offers saved profiles alongside Custom targets,
and native Quick export uses the default. Ordinary manifest edits preserve them.

Native profiles build a complete staged directory with rollback. Browser profiles
create a complete ZIP before download. Both record artifact hashes and diagnostics
in `manifest.json`, preserve ordinary Markdown prose and local images, and include
portable output bundles. Native live HTML keeps visible initial output while its
local runtime starts. Browser live requests retain a static result with a warning.
Notebook binary requests produce explicit source fallbacks: use CLI publication
builds for native LaTeX/PDF/PNG/GIF tools. Cancellation/time budgets in the current
Notebook engine are cooperative between export steps, not preemptive inside a cell.

See [publication workflows](../rix/documentation/eval/publication-workflows.md)
and the [runnable showcase](../rix/examples/publication-workflow/README.md).

## Embedded Cel workbooks

Notebook cells can open `.rixcel` sheets and `.rixbook` workbooks with
`book := .celOpen("data.rixbook", "sales")`. Paths are relative to the current
note, including when a publication exports several notes. Native Notebook reads
only through the selected project/folder grant; Notebook Web reads only from the
uploaded project ZIP. Opening a standalone note does not grant access to adjacent
files. Paths must remain inside the selected workspace; URLs, scripts, notebook
imports, cycles, and documents over 8 MB are rejected.

Use `.cel(JSON text, optionalDocumentId)` for embedded data requiring no host
reader. Both constructors return an independent session handle:

- `book.Sheet()` renders an editable sheet using the shared RiX Sheet widget.
- `book.View("subtotal")` renders a named export and observes edits on that handle.
- `book.Get("subtotal")` reads its exact current value for a calculation.
- `book.Set([1,1], "7/3")` commits a source edit through workbook validation.
- `book.Record()` returns JSON for an explicit save; edits never write back to disk.
- `book.Dispose()` releases the handle early. Rerunning or closing the notebook
  also disposes its embedded workbooks and subscriptions.

A different constructor call creates independent state, even for the same path.
Static exports contain the rendered sheet and named values. A downloaded live
page cannot reopen project paths; its initial static result remains available.
Embed JSON with `.cel` for portable interaction. See the runnable
[Cel notebook example](examples/cel-embedding/README.md).

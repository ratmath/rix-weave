import { createLiveNotebookEngine, liveSourceDocument } from "./notebook-web/live-document.js";
import { disposeNotebookRun } from "./notebook-web/rix-engine.js";
import { relocateLivePublicationAssets } from "../../../rix/src/runtime/live-publication.js";
import renderMathInElement from "katex/contrib/auto-render";
import outputWidgetStyles from "../../../rix/styles/output-widgets.css?inline";
import {
  formatValue,
  isOutputValue,
  mountOutputWidgets,
  parseAndEvaluate,
  renderOutputHtml,
} from "../../../rix/src/index.js";
import { gridLatex } from "./output-latex.js";

const payloadElement = document.querySelector("#rix-live-document");
const sourceCellElements = [...document.querySelectorAll("[data-rix-source-cell]")];

if (payloadElement || sourceCellElements.length) {
  const payload = payloadElement ? JSON.parse(payloadElement.textContent) : null;
  const controls = document.querySelector("#rix-live-controls");
  const sliderOverrides = new Map();
  let widgetDisposers = [];
  const engine = createLiveNotebookEngine();
  let generation = 0;
  let closed = false;
  const extracted = payload ? null : liveSourceDocument(sourceCellElements.map((element, position) => ({
    index: Number(element.dataset.rixCell ?? position), header: element.dataset.rixHeader || "",
    code: (element.matches("code") ? element : element.querySelector("code"))?.textContent || "",
  })));
  const source = payload?.source ?? extracted.source;
  window.addEventListener("pagehide", () => { closed = true; generation++; for (const dispose of widgetDisposers.splice(0)) dispose(); engine.dispose(); }, { once: true });

  installStyles();
  document.documentElement.classList.add("rix-live-ready");
  hideRuntimeSources();
  run().catch(reportFailure);

  function hideRuntimeSources() {
    for (const sourceCell of sourceCellElements) {
      sourceCell.hidden = true;
      sourceCell.style.setProperty("display", "none", "important");
    }
  }

  function showInitial(initial, visible) {
    initial.hidden = !visible;
    for (const element of initial.querySelectorAll(visible ? "[data-rix-original-id]" : "[id]")) {
      if (visible) { element.id = element.dataset.rixOriginalId; delete element.dataset.rixOriginalId; }
      else { element.dataset.rixOriginalId = element.id; element.removeAttribute("id"); }
    }
  }

  function reportFailure(error) {
    if (closed || error?.name === "AbortError") return;
    for (const initial of document.querySelectorAll("[data-rix-initial-cell]")) showInitial(initial, true);
    if (controls) { controls.hidden = false; controls.textContent = `Live notebook: ${error.message || error}. The static result remains available.`; }
  }

  async function run() {
    const token = ++generation;
    for (const initial of document.querySelectorAll("[data-rix-initial-cell]")) showInitial(initial, true);
    for (const dispose of widgetDisposers.splice(0)) dispose();
    for (const widget of document.querySelectorAll("[data-rix-live-cell]")) widget.replaceChildren();
    const result = await engine.executeDocumentAsync(source, { mode: "live", sliderOverrides });
    if (closed || token !== generation) { await disposeNotebookRun(result); return; }
    for (const cellRun of result.runs) {
      const cell = { ...cellRun.cell, index: extracted?.indices[cellRun.cell.index] ?? cellRun.cell.index };
      const failure = cellRun.statements.find(statement => statement.kind === "error");
      const liveResult = failure ? { error: failure.content } : cellRun.liveOutput ? { ...cellRun.liveOutput, error: null } : null;
      if (cell.metadata.role !== "set") renderWidget(cell, { liveResult }, result.runtime);
    }
    renderControls(result.sliders);
  }

  function renderWidget(cell, execution, runtime) {
    const widget = document.querySelector(`[data-rix-live-cell="${cell.index}"]`);
    if (!widget) return;
    const showCode = widget.dataset.rixShowCode === undefined
      ? cell.metadata.showCode
      : widget.dataset.rixShowCode === "true";
    const code = showCode ? `<details class="rix-live-source"><summary>RiX code</summary><pre><code>${escapeLiveHtml(cell.code)}</code></pre></details>` : "";
    const result = execution.liveResult;
    if (result && !result.error) { const initial = document.querySelector(`[data-rix-initial-cell="${cell.index}"]`); if (initial) showInitial(initial, false); }
    let output = "";
    if (cell.metadata.showOutput && result) {
      output = result.error
        ? `<pre class="rix-live-error">${escapeLiveHtml(result.error)}</pre>`
        : `<div class="rix-live-output">${renderLiveValue(result.value)}</div>`;
    }
    widget.innerHTML = `${code}${output}`;
    renderMathInElement(widget, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      throwOnError: false,
    });
    normalizeLiveTables(widget);
    if (result?.value) {
      widgetDisposers.push(mountOutputWidgets(widget, relocateLivePublicationAssets(result.value, payload?.assetPaths || {}), {
        incrementalSvg: true,
        format: formatValue,
        render: renderLiveValue,
        observe: result.observed?.observe ? listener => result.observed.observe((value, event) => listener(relocateLivePublicationAssets(value, payload?.assetPaths || {}), event)) : null,
        evaluateEdit: (source, { mode }) => parseAndEvaluate(mode === "formula" ? `@{ ${source} }` : source, {
          context: runtime.context,
          registry: runtime.registry,
          systemContext: runtime.systemContext,
          file: `<live widget in cell ${cell.index + 1}>`,
        }),
      }));
    }
  }

  function normalizeLiveTables(widget) {
    for (const table of widget.querySelectorAll("table.rix-output-table")) {
      table.style.setProperty("display", "inline-table", "important");
      table.style.setProperty("width", "auto", "important");
      table.style.setProperty("max-width", "100%", "important");
      table.style.setProperty("table-layout", "auto", "important");
      for (const cell of table.querySelectorAll("th, td")) cell.style.setProperty("width", "auto", "important");
    }
  }

  function renderLiveValue(value) {
    value = relocateLivePublicationAssets(value, payload?.assetPaths || {});
    if (!isOutputValue(value)) return `<pre>${escapeLiveHtml(formatValue(value))}</pre>`;
    if (value.kind === "grid") return `<div class="rix-live-math-grid">${gridLatex(value, formatValue)}</div>`;
    if (value.kind === "fragment") return value.children.map(renderLiveValue).join("");
    if (value.kind === "figure") {
      return `<figure${value.label ? ` id="${escapeLiveHtml(value.label)}"` : ""}>${renderLiveValue(value.content)}${value.caption ? `<figcaption>${escapeLiveHtml(value.caption)}</figcaption>` : ""}</figure>`;
    }
    if (value.kind === "slide") return `<section class="rix-live-slide">${value.title ? `<h2>${escapeLiveHtml(value.title)}</h2>` : ""}${renderLiveValue(value.content)}</section>`;
    if (value.kind === "slides") return value.slides.map(renderLiveValue).join("");
    return renderOutputHtml(value, formatValue);
  }

  function renderControls(sliders) {
    if (!controls) return;
    controls.replaceChildren();
    controls.hidden = sliders.length === 0;
    for (const slider of sliders) {
      const label = document.createElement("label");
      label.className = "rix-live-slider";
      const name = document.createElement("span");
      name.textContent = slider.name;
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = String(slider.steps);
      input.value = String(slider.index);
      const value = document.createElement("output");
      value.textContent = formatValue(slider.value);
      input.addEventListener("input", () => {
        sliderOverrides.set(slider.id, Number(input.value));
        run().catch(reportFailure);
      });
      label.append(name, input, value);
      controls.append(label);
    }
  }

  function escapeLiveHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }

  function installStyles() {
    if (document.querySelector("#rix-live-styles")) return;
    const style = document.createElement("style");
    style.id = "rix-live-styles";
    style.textContent = `${outputWidgetStyles}\n.rix-live-ready .rix-runtime-source,.rix-live-ready [data-rix-source-cell]{display:none}.rix-live-controls{display:grid;gap:.55rem;margin:1rem 0;padding:.8rem;background:#f4f7fb;border:1px solid #cbd9e9;border-radius:6px}.rix-live-slider{display:grid;grid-template-columns:auto minmax(8rem,1fr) auto;align-items:center;gap:.65rem;font:14px system-ui,sans-serif}.rix-live-slider input{accent-color:#35557b}.rix-live-widget{margin:1rem 0}.rix-live-source summary{cursor:pointer;color:#35557b}.rix-live-source pre,.rix-live-output pre,.rix-live-error{overflow:auto;padding:.8rem;background:#f4f2ec;border-radius:5px}.rix-live-math-grid{overflow:auto;margin:1rem 0}.rix-live-error{color:#8a2520;background:#fbe9e7}.rix-live-output table{border-collapse:collapse}.rix-live-output .rix-output-table{display:inline-table!important;width:auto!important;max-width:100%;table-layout:auto}.rix-live-output th,.rix-live-output td{width:auto!important;padding:.3rem .5rem;border:1px solid #cfd8e5}.rix-live-output th{background:#edf3fa}.rix-live-output svg{display:block;max-width:100%;height:auto}.rix-output-sheet{display:inline-grid;max-width:100%;gap:.35rem;font-variant-numeric:tabular-nums}.rix-output-sheet-title{margin:0;font:600 14px system-ui,sans-serif}.rix-output-sheet-location{min-height:1.35em;color:#657080;font:12px system-ui,sans-serif}.rix-output-sheet-plane-controls{display:flex;flex-wrap:wrap;gap:.4rem .65rem;padding:.42rem .5rem;border:1px solid #dbe2ea;border-radius:4px;background:#f8fafc}.rix-output-sheet-plane-controls label{display:inline-flex;align-items:center;gap:.35rem;color:#486078;font:600 11px system-ui,sans-serif}.rix-output-sheet-plane-controls select{min-width:3rem;padding:.16rem .35rem;border:1px solid #b8c5d4;border-radius:4px;background:#fff;color:#28313c;font:inherit}.rix-output-sheet table{border:1px solid #cfd8e5;background:#fff}.rix-output-sheet th,.rix-output-sheet td{min-width:3.4rem;padding:.3rem .5rem;border:1px solid #dbe2ea;text-align:right;white-space:nowrap}.rix-output-sheet th{color:#486078;background:#edf3fa;font:600 12px system-ui,sans-serif}.rix-output-sheet td{cursor:cell;outline:0}.rix-output-sheet td:hover{background:#f5f8fc}.rix-output-sheet td:focus,.rix-output-sheet td.rix-sheet-cell-selected{background:#eef2ff;box-shadow:inset 0 0 0 2px #6366f1}`;
    style.textContent += '.rix-output-sheet td[data-rix-state="error"]{position:relative;background:#fff1f2;box-shadow:inset 0 0 0 1px #e11d48}.rix-output-sheet td[data-rix-state="error"]::after{content:"!";position:absolute;top:1px;right:3px;color:#be123c;font:700 10px/1 system-ui,sans-serif}.rix-output-sheet td[data-rix-state="error"]:focus,.rix-output-sheet td[data-rix-state="error"].rix-sheet-cell-selected{background:#fff1f2;box-shadow:inset 0 0 0 2px #e11d48}';
    style.textContent += '.rix-output-drag-point{cursor:grab;outline:none;filter:drop-shadow(0 1px 2px rgb(15 23 42/.35))}.rix-output-drag-point:hover,.rix-output-drag-point:focus{stroke:#fff;stroke-width:3;filter:drop-shadow(0 0 4px #7c3aed)}.rix-output-drag-point-active{cursor:grabbing}.rix-output-graphic-status{display:block;margin-top:.3rem;color:#6d28d9;font:11px/1.35 system-ui,sans-serif}';
    document.head.append(style);
  }
}

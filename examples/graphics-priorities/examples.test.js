import { expect, test } from "bun:test";
import { createNotebookBundledPluginCatalog } from "../../webview/source/bundled-plugin-catalog.js";
import { createRixNotebookEngine } from "../../webview/source/notebook-web/rix-engine.js";

const notebooks = [
  "01-geometry-authoring",
  "02-points-of-interest",
  "03-dense-performance",
  "04-advanced-3d",
  "05-semantic-animation",
];

for (const directory of notebooks) {
  test(`${directory} contains five executable studies`, async () => {
    const source = await Bun.file(new URL(`./${directory}/index.md`, import.meta.url)).text();
    const engine = createRixNotebookEngine({ pluginCatalog: createNotebookBundledPluginCatalog() });
    const run = engine.executeDocument(source);
    const errors = run.outputStatements.filter(({ kind }) => kind === "error");
    expect(run.runs.length, directory).toBe(5);
    expect(errors, directory).toEqual([]);
  }, 180_000);
}

// The app runs notebooks on the async path, with per-cell step/time budgets.
for (const directory of notebooks) {
  test(`${directory} also runs on the async path within its per-cell budgets`, async () => {
    const source = await Bun.file(new URL(`./${directory}/index.md`, import.meta.url)).text();
    const engine = createRixNotebookEngine({ pluginCatalog: createNotebookBundledPluginCatalog() });
    try {
      const run = await engine.executeDocumentAsync(source);
      const errors = run.outputStatements.filter(({ kind }) => kind === "error");
      expect(run.runs.length, directory).toBe(5);
      expect(errors, directory).toEqual([]);
    } finally {
      await engine.dispose();
    }
  }, 180_000);
}

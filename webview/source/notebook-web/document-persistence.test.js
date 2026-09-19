import { expect, test } from "bun:test";
import { createNotebookBundledPluginCatalog } from "../bundled-plugin-catalog.js";
import { createRixNotebookEngine, disposeNotebookRun } from "./rix-engine.js";

test("Notebook imports the same inert document tree with exact cells", () => {
    const engine=createRixNotebookEngine({pluginCatalog:createNotebookBundledPluginCatalog()});
    const run=engine.executeDocument(`\`\`\`rix
.Plugin.Load("document");
report := .Fragment([.Paragraph([.Strong("Exact"),1/3]),.Table(["oriented"],[[5:4]])]);
saved := .document.EncodeJSON(report);
imported := .document.DecodeJSON(saved);
imported[:value];
\`\`\``);
    try {
        expect(run.outputStatements.map(s=>s.kind)).not.toContain("error");
        const value=run.runs[0].liveOutput.value;
        expect(value.kind).toBe("fragment");
        expect(value.children[1].rows[0][0].start.toString()).toBe("5");
        expect(value.children[1].rows[0][0].end.toString()).toBe("4");
    } finally { disposeNotebookRun(run); }
});

import { Integer } from "@ratmath/core";
import { expect, test } from "bun:test";
import { parseAndEvaluate, formatValue } from "../../../../rix/src/index.js";
import { createNotebookBundledPluginCatalog } from "../bundled-plugin-catalog.js";
import { createRixNotebookEngine, disposeNotebookRun } from "./rix-engine.js";
import { registerAsyncResource } from "../../../../rix/src/runtime/async-runtime.js";
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function engine(impl = async ([value]) => value) {
    const catalog = createNotebookBundledPluginCatalog();
    catalog.addMetadata({ id: "async-test", description: "Async host fixture", kind: "host", mount: "asyncTest", exports: [], groups: [], permissions: [] });
    catalog.registerInstaller("async-test", ({ systemContext }) => systemContext.registerHost("waitValue", { impl, concurrency: "safe", cancellation: "cooperative" }));
    return createRixNotebookEngine({ pluginCatalog: catalog, plugins: ["async-test"] });
}
test("Notebook async cells, inlines and mode publication retain ordered concrete values", async () => {
    const host = engine();
    const run = await host.executeDocumentAsync('```rix\nx := .waitValue(3);\n.static({; x := .waitValue(4); });\n.out(.waitValue(x^2));\n```\nAnswer @{.waitValue(x)}.', { mode: "static" });
    expect(run.runs[0].staticOutput.content).toBe("16");
    expect(run.renderedSource).toContain("Answer 4.");
    expect(run.outputStatements.every((statement) => statement.kind === "result")).toBe(true);
    expect(run.runs[0].staticOutput.value).toBeInstanceOf(Integer);
    await host.dispose();
});
test("Notebook rerun cancels a pending host operation, suppresses stale results and closes resources", async () => {
    const started = deferred(); let closed = 0, signal;
    const host = engine(async ([value], context, _run, execution) => {
        signal = execution.signal;
        registerAsyncResource(context, {}, () => { closed++; });
        started.resolve();
        await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        return value;
    });
    const old = host.executeDocumentAsync('```rix\n.waitValue(1);\n```'); old.catch(() => {});
    await started.promise;
    const next = await host.executeDocumentAsync('```rix\n2+3;\n```');
    await expect(old).rejects.toThrow();
    expect(signal.aborted).toBe(true); expect(closed).toBe(1); expect(next.runs[0].liveOutput.content).toBe("5");
    await host.dispose(); await expect(host.executeDocumentAsync("")).rejects.toThrow("closed");
});
test("async observed outputs remain reactive until disposal; budgets span all cells", async () => {
    const host = engine();
    const run = await host.executeDocumentAsync('```rix\n$$amount := 2;\n$$view := .Text($amount);\n$view;\n```');
    const values = []; run.runs[0].liveOutput.observed.observe((value) => values.push(formatValue(value)));
    parseAndEvaluate('$amount := 7', { context: run.runtime.context, registry: run.runtime.registry, systemContext: run.runtime.systemContext });
    expect(values).toEqual(["7"]);
    await disposeNotebookRun(run);
    await expect(host.executeDocumentAsync('```rix\n1+2+3;\n```\n```rix\n4+5+6;\n```', { maxSteps: 8 })).rejects.toThrow("step limit");
    await host.dispose();
});
test("late uncooperative host values cannot replace a newer run", async () => {
    const started = deferred(), gate = deferred();
    const host = engine(async ([value]) => { started.resolve(); await gate.promise; return value; });
    const old = host.executeDocumentAsync('```rix\n.waitValue(1);\n```'); old.catch(() => {});
    await started.promise;
    const current = await host.executeDocumentAsync('```rix\n19;\n```');
    gate.resolve(); await expect(old).rejects.toThrow();
    expect(current.runs[0].liveOutput.content).toBe("19"); await host.dispose();
});
test("reset closes resources from flow, singleton and refresh contexts", async () => {
    let closed = 0;
    const host = engine(async ([value], context) => { registerAsyncResource(context, {}, () => { closed++; }); return value; });
    await host.executeDocumentAsync('```rix\n.waitValue(1);\n```\n```rix singleton\n.waitValue(2);\n```\n```rix refresh\n.waitValue(3);\n```');
    expect(await host.reset()).toEqual([]); expect(closed).toBe(3);
    await host.dispose(); expect(closed).toBe(3);
});

test("Notebook reset owns resources acquired by concurrent descendant contexts", async () => {
    let closed = 0;
    const host = engine(async ([value], context) => { registerAsyncResource(context, {}, () => { closed++; }); return value; });
    const run = await host.executeDocumentAsync('```rix\n{$:2$ [.waitValue(1), .waitValue(2)] };\n```');
    expect(run.runtime.contexts.size).toBeGreaterThan(1);
    expect(await host.reset()).toEqual([]); expect(closed).toBe(2);
    const child = [...run.runtime.contexts].find((context) => context !== run.runtime.context);
    expect(() => registerAsyncResource(child, {}, () => {})).toThrow("shutdown");
    await host.dispose(); expect(closed).toBe(2);
});

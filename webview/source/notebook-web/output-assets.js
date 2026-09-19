import { bundleOutputDocument, encodeOutputBundle, normalizeAssetReference, OUTPUT_ASSET_LIMITS } from "../../../../rix/src/runtime/output-assets.js";
import { isOutputValue } from "../../../../rix/src/runtime/output.js";

/** The DocumentStore already owns the user's selected directory/ZIP grant. */
export function createNotebookAssetStore(store, { directory = "/", packages = {} } = {}) {
  return Object.freeze({
    async readAsset(ref, { maxBytes = OUTPUT_ASSET_LIMITS.maxAssetBytes, signal } = {}) {
      normalizeAssetReference(ref); signal?.throwIfAborted();
      const match = /^package:([^/]+)\/(.+)$/.exec(ref);
      const root = match ? packages[match[1]] : directory;
      if (!root || ref.startsWith("sha256:")) throw Object.assign(new Error("Asset is absent from the notebook grant"), { code: "asset-missing" });
      const path = `${root.replace(/\/$/, "")}/${match ? match[2] : ref}`;
      const data = await store.readBinary(path);
      signal?.throwIfAborted();
      if (!(data instanceof Uint8Array) || data.length > maxBytes) throw Object.assign(new Error("Notebook asset exceeds the byte budget"), { code: "asset-byte-limit" });
      return data;
    },
  });
}

/** Snapshot only structured publications; ordinary calculation output keeps its current formatting. */
export async function bundleNotebookRun(run, options = {}) {
  const indexes = run.runs.flatMap((cell, index) => cell?.metadata.role !== "set" && cell?.staticOutput?.kind !== "error" && isOutputValue(cell?.staticOutput?.value) ? [index] : []);
  const bundle = await bundleOutputDocument({ type: "output", kind: "fragment", children: indexes.map(index => run.runs[index].staticOutput.value), metadata: null, style: null }, options);
  const replacements = new Map(indexes.map((index, position) => [index, bundle.document.children[position]]));
  const runs = run.runs.map((cell, index) => replacements.has(index) ? { ...cell, staticOutput: { ...cell.staticOutput, value: replacements.get(index) } } : cell);
  return { ...run, runs, outputBundle: bundle, outputBundleJSON: encodeOutputBundle(bundle, options) };
}

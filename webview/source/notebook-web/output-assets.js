import { bundleOutputDocument, encodeOutputBundle, normalizeAssetReference, OUTPUT_ASSET_LIMITS } from "../../../../rix/src/runtime/output-assets.js";
import { isOutputValue } from "../../../../rix/src/runtime/output.js";

/** Tauri-style open handles are read in bounded chunks, including files that grow during export. */
export function createBoundedBinaryStore(openFile) {
  return Object.freeze({
    async readBinary(path, { maxBytes = OUTPUT_ASSET_LIMITS.maxAssetBytes, signal } = {}) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > OUTPUT_ASSET_LIMITS.maxAssetBytes * 16) throw new Error("Invalid notebook asset byte budget");
      signal?.throwIfAborted();
      const handle = await openFile(path, { read: true });
      try {
        signal?.throwIfAborted();
        const info = await handle.stat();
        if (!info.isFile || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > maxBytes) throw Object.assign(new Error("Notebook asset exceeds the byte budget or is not a file"), { code: "asset-byte-limit" });
        const data = new Uint8Array(info.size);
        let offset = 0;
        while (offset < data.length) {
          signal?.throwIfAborted();
          const chunk = data.subarray(offset, Math.min(offset + 65536, data.length));
          const read = await handle.read(chunk);
          if (!Number.isSafeInteger(read) || read < 1 || read > chunk.length) throw Object.assign(new Error("Notebook asset changed while reading"), { code: "asset-read-failed" });
          offset += read;
        }
        signal?.throwIfAborted();
        if (await handle.read(new Uint8Array(1))) throw Object.assign(new Error("Notebook asset grew while reading"), { code: "asset-byte-limit" });
        return data;
      } finally { await handle.close(); }
    },
  });
}

/** The DocumentStore already owns the user's selected directory/ZIP grant. */
export function createNotebookAssetStore(store, { directory = "/", packages = {}, contentPaths = {} } = {}) {
  return Object.freeze({
    async readAsset(ref, { maxBytes = OUTPUT_ASSET_LIMITS.maxAssetBytes, signal } = {}) {
      normalizeAssetReference(ref); signal?.throwIfAborted();
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > OUTPUT_ASSET_LIMITS.maxAssetBytes * 16) throw new Error("Invalid notebook asset byte budget");
      if (ref.startsWith("sha256:")) {
        ref = contentPaths[ref];
        if (!ref) throw Object.assign(new Error("Content hash is absent from the notebook grant"), { code: "asset-missing" });
        normalizeAssetReference(ref);
      }
      const match = /^package:([^/]+)\/(.+)$/.exec(ref);
      const root = match ? packages[match[1]] : directory;
      if (!root || ref.startsWith("sha256:")) throw Object.assign(new Error("Asset is absent from the notebook grant"), { code: "asset-missing" });
      const path = `${root.replace(/\/$/, "")}/${match ? match[2] : ref}`;
      const size = store.stat ? (await store.stat(path)).size : store.files?.get(path)?.byteLength;
      if (size !== undefined && (!Number.isSafeInteger(size) || size > maxBytes)) throw Object.assign(new Error("Notebook asset exceeds the byte budget"), { code: "asset-byte-limit" });
      signal?.throwIfAborted();
      const data = await store.readBinary(path, { maxBytes, signal });
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

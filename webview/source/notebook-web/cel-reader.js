/** Read Cel data only through an explicitly supplied Notebook document store. */
export const CEL_DOCUMENT_MAX_BYTES = 8_000_000;
function canonical(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '..') { if (!parts.length) throw new Error('Cel path leaves the selected workspace'); parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}
export function createNotebookCelReader({ store, notePath, root, host = 'Notebook', importStack = [] } = {}) {
  return async (reference, { signal, importStack: inherited = [] } = {}) => {
    signal?.throwIfAborted();
    if (!notePath || !root || !store) throw new Error(`CelOpen is unavailable in this ${host} document; open a project containing the workbook or use .cel(JSON text)`);
    if (typeof reference !== 'string' || !reference || /[\\\u0000-\u001f?#]/.test(reference) || /^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(reference)) throw new Error('CelOpen requires a relative .rixcel or .rixbook path');
    const base = canonical(notePath), boundary = canonical(root);
    const target = canonical(`${base.slice(0, base.lastIndexOf('/'))}/${reference}`);
    const stack = [...new Set([base, ...importStack, ...inherited])];
    if (stack.includes(target)) throw new Error(`Cel document import cycle: ${[...stack, target].join(' -> ')}`);
    if (!/\.(rixcel|rixbook)$/i.test(target)) throw new Error('CelOpen reads .rixcel and .rixbook data only; script and notebook imports are unavailable');
    if (boundary !== '/' && !target.startsWith(`${boundary}/`)) throw new Error('Cel path leaves the selected workspace');
    const entry = store.files?.get(target);
    const size = typeof entry === 'string' ? new TextEncoder().encode(entry).byteLength : entry?.byteLength;
    if (size > CEL_DOCUMENT_MAX_BYTES) throw new Error('Cel document byte budget exceeded');
    let source;
    try {
      if (store.readBinary) {
        const bytes = await store.readBinary(target, { maxBytes: CEL_DOCUMENT_MAX_BYTES, signal });
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > CEL_DOCUMENT_MAX_BYTES) throw new Error('Cel document byte budget exceeded');
        source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } else source = await store.readText(target);
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Cel workbook unavailable in ${host}: ${reference}: ${error.message}`, { cause: error });
    }
    signal?.throwIfAborted();
    if (typeof source !== 'string' || new TextEncoder().encode(source).byteLength > CEL_DOCUMENT_MAX_BYTES) throw new Error('Cel document byte budget exceeded');
    return { source, identity: target, importStack: stack };
  };
}

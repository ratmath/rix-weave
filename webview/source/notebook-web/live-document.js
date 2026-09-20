import { createRixNotebookEngine } from './rix-engine.js';
import { createNotebookBundledPluginCatalog } from '../bundled-plugin-catalog.js';

/** Quarto source cells preserve their original widget indices without evaluating DOM content. */
export function liveSourceDocument(cells) {
  if (!Array.isArray(cells) || cells.length > 512) throw new Error('Live notebook cell budget exceeded');
  const sorted = [...cells].sort((a, b) => a.index - b.index);
  const seen = new Set(); let size = 0;
  for (const cell of sorted) {
    if (!Number.isSafeInteger(cell.index) || cell.index < 0 || cell.index > 1_000_000 || seen.has(cell.index)) throw new Error('Invalid or duplicate live notebook cell index');
    if (typeof cell.code !== 'string' || /^```/m.test(cell.code) || typeof (cell.header ?? '') !== 'string' || /[\r\n]/.test(cell.header || '')) throw new Error('Invalid live notebook source cell');
    size += cell.code.length + (cell.header || '').length; if (size > 1024 * 1024) throw new Error('Live notebook source budget exceeded');
    seen.add(cell.index);
  }
  return { source: sorted.map(cell => `\`\`\`rix ${cell.header || ''}\n${cell.code}\n\`\`\``).join('\n\n'), indices: sorted.map(cell => cell.index) };
}

/** Published documents reuse the editor's bounded async execution and finalization. */
export function createLiveNotebookEngine(configuration = {}) {
  return createRixNotebookEngine({ pluginCatalog: createNotebookBundledPluginCatalog(), ...configuration });
}

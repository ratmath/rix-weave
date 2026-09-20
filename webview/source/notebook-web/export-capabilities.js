/** Capabilities describe this host's exporter, not tools installed elsewhere on the machine. */
export function notebookExportCapabilities({ host = 'browser', liveHtml = false } = {}) {
  if (!['browser', 'native'].includes(host)) throw new Error('Unknown Notebook host');
  return Object.freeze({ host, targets: Object.freeze(['markdown', 'text', 'html', 'quarto', 'bundle']), liveHtml: host === 'native' && liveHtml, nativeCompilation: false, projectStorage: host === 'native' ? 'granted-directory' : 'browser-zip', nativePluginGrants: host === 'native' });
}
export function notebookExportNotice(capabilities, profile = null) {
  const unavailable = (profile?.targets || []).filter((target) => !capabilities.targets.includes(target));
  const details = [capabilities.liveHtml ? 'HTML includes local live widgets with a static initial result.' : 'HTML contains static results; live widgets require the native Notebook or CLI exporter.'];
  if (unavailable.length) details.push(`${unavailable.join(', ')} compilation is unavailable here. Export includes a diagnostic and rendered source; use the CLI publication build for those targets.`);
  else details.push('Markdown and Quarto export source files. PDF, LaTeX compilation and other native tools run through the CLI publication build.');
  if (capabilities.host === 'browser') details.push('Projects use browser files or ZIP storage; native filesystem and JavaScript plugin grants are unavailable.');
  return details.join(' ');
}
export function updateExportCapabilityNotice(dialog, capabilities, profile) {
  let notice = dialog.querySelector('[data-rix-export-capabilities]');
  if (!notice) { notice = dialog.ownerDocument.createElement('p'); notice.dataset.rixExportCapabilities = ''; notice.setAttribute('role', 'status'); (dialog.querySelector('form') || dialog).append(notice); }
  notice.textContent = notebookExportNotice(capabilities, profile);
}

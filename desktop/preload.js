// The bridge the app sees as window.revoDesktop. Only these functions; nothing else from Node or Electron reaches the page.
const { contextBridge, ipcRenderer } = require('electron');
const bytesOf = b => (b instanceof Uint8Array ? b : new Uint8Array(b));
contextBridge.exposeInMainWorld('revoDesktop', {
  platform: process.platform,
  info: () => ipcRenderer.invoke('app:info'),
  // Printers installed on this computer: [{ name, displayName, isDefault, status }]
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  // ESC/POS bytes to a printer installed here (RAW through its driver). Rejects with a short Arabic message.
  printRaw: (printer, bytes) => ipcRenderer.invoke('print:raw', { printer: String(printer || ''), bytes: bytesOf(bytes) }),
  // ESC/POS bytes to host:port over the network (port 9100 by default).
  printNet: (host, port, bytes) => ipcRenderer.invoke('print:net', { host: String(host || ''), port: Number(port) || 9100, bytes: bytesOf(bytes) }),
  // A ready HTML paper, printed silently through the driver (fallback for drivers that refuse RAW data). widthMm: 80 or 58.
  printHtml: (printer, html, widthMm) => ipcRenderer.invoke('print:html', { printer: String(printer || ''), html: String(html || ''), widthMm: Number(widthMm) || 80 }),
  // Is the network printer answering right now?
  probe: (host, port) => ipcRenderer.invoke('print:probe', { host: String(host || ''), port: Number(port) || 9100 }),
  openExternal: url => ipcRenderer.invoke('app:openExternal', String(url || '')),
  toggleFullscreen: () => ipcRenderer.invoke('app:fullscreen'),
  reload: () => ipcRenderer.invoke('app:reload'),
});

// Revo desktop: a thin shell around the hosted app (the same app, the same account) that adds what a browser cannot do:
// silent printing to the computer's printers, raw printing to network printers, a USB printer chooser, and a window that
// remembers its size. The app itself updates on the server; this shell rarely needs to change.
const { app, BrowserWindow, Menu, shell, session, ipcMain, dialog, net, nativeTheme } = require('electron');
const path = require('path'); const fs = require('fs');
const printing = require('./lib/printing'); const { windowState } = require('./lib/state');

const APP_URL = process.env.REVO_URL || 'https://hussain98898.github.io/revo/cloud/app/';
const APP_ORIGIN = new URL(APP_URL).origin;
const RELEASES_API = 'https://api.github.com/repos/hussain98898/revo/releases/latest';
const RELEASES_PAGE = 'https://github.com/hussain98898/revo/releases/latest';

app.setAppUserModelId('ly.revo.desktop');
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
const state = windowState(app.getPath('userData'));

function createWindow() {
  const st = state.get();
  win = new BrowserWindow({
    x: st.x, y: st.y, width: st.width, height: st.height, minWidth: 720, minHeight: 540,
    show: false, autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1320' : '#ffffff',
    title: 'ريڤو', icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  state.track(win);
  if (st.maximized) win.maximize();
  if (st.fullscreen) win.setFullScreen(true);
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    // -3 is "aborted" (a normal redirect or a stopped load). Anything else on the main frame: show the offline page.
    if (!isMain || code === -3) return;
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: APP_URL, code: String(code) } });
  });
  // Links to other sites open in the system browser; the app itself stays in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // a preview of the restaurant's ordering site (same origin) opens in a phone-sized window; anything else goes to the system browser
    if (url.startsWith(APP_ORIGIN)) return { action: 'allow', overrideBrowserWindowOptions: { width: 440, height: 860, autoHideMenuBar: true, webPreferences: { preload: undefined, sandbox: true, contextIsolation: true } } };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (/^https?:/.test(url) && !url.startsWith(APP_ORIGIN) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on('page-title-updated', e => e.preventDefault());
  win.on('closed', () => { win = null; });
  win.loadURL(APP_URL);
}

// Permissions: USB (the printers), notifications and full screen for our app; nothing else.
function setupPermissions(ses) {
  const ours = origin => !origin || origin.startsWith(APP_ORIGIN) || origin.startsWith('file:');
  const allowed = new Set(['usb', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read', 'window-management']);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(allowed.has(permission) && ours(details && details.requestingUrl)));
  ses.setPermissionCheckHandler((wc, permission, origin) => allowed.has(permission) && ours(origin));
  ses.setDevicePermissionHandler(details => details.deviceType === 'usb' && ours(details.origin));
  // The browser's USB chooser does not exist in Electron, so the list of printers is shown as a small dialog.
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const list = (details.deviceList || []).filter(d => d.productName || d.vendorId);
    if (!list.length) { dialog.showMessageBox(win, { type: 'info', message: 'لم تُعثر على أي طابعة USB', detail: 'وصّل الطابعة بكيبل USB وشغّلها ثم أعد المحاولة.', buttons: ['حسنًا'] }); return callback(); }
    const names = list.slice(0, 8).map(d => (d.productName || ('USB ' + d.vendorId + ':' + d.productId)).slice(0, 40));
    dialog.showMessageBox(win, { type: 'question', message: 'اختر الطابعة', detail: 'الأجهزة الموصولة بهذا الكمبيوتر الآن:', buttons: names.concat(['إلغاء']), cancelId: names.length, noLink: true })
      .then(r => callback(r.response < names.length ? list[r.response].deviceId : undefined)).catch(() => callback());
  });
}

// Silent printing of a ready HTML paper through the printer's own driver (the fallback when RAW data is refused).
function printHtmlSilent(printerName, html, widthMm) {
  return new Promise((resolve, reject) => {
    const w = new BrowserWindow({ show: false, width: 420, height: 800, webPreferences: { sandbox: true, contextIsolation: true } });
    const done = (err) => { try { w.destroy(); } catch (e) { /* gone */ } err ? reject(err) : resolve(true); };
    const timer = setTimeout(() => done(new Error('انتهت مهلة الطباعة')), 40000);
    w.webContents.once('did-finish-load', async () => {
      try {
        const px = await w.webContents.executeJavaScript('Math.max(document.body.scrollHeight, 200)');
        const widthMicrons = Math.round((Number(widthMm) || 80) * 1000); const heightMicrons = Math.max(60000, Math.round(px * 25.4 / 96 * 1000) + 8000);
        w.webContents.print({ silent: true, deviceName: printerName, printBackground: true, color: false, margins: { marginType: 'none' }, pageSize: { width: widthMicrons, height: heightMicrons } }, (ok, reason) => { clearTimeout(timer); ok ? done(null) : done(new Error(reason === 'Invalid deviceName provided' ? printing.MSG.noPrinter : 'لم تقبل الطابعة المهمة' + (reason ? ' (' + reason + ')' : ''))); });
      } catch (e) { clearTimeout(timer); done(e); }
    });
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

function setupIpc() {
  const okWin = e => e.sender === (win && win.webContents);
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron, url: APP_URL }));
  ipcMain.handle('printers:list', async e => { if (!okWin(e)) return []; try { const ps = await e.sender.getPrintersAsync(); return ps.map(p => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault, status: p.status })); } catch (err) { return []; } });
  ipcMain.handle('print:net', async (e, a) => { if (!okWin(e)) throw new Error('مرفوض'); return printing.printNet(a.host, a.port, a.bytes); });
  ipcMain.handle('print:probe', async (e, a) => { if (!okWin(e)) return false; return printing.probe(a.host, a.port); });
  ipcMain.handle('print:raw', async (e, a) => { if (!okWin(e)) throw new Error('مرفوض'); let list = []; try { list = await e.sender.getPrintersAsync(); } catch (err) { /* fine */ } return printing.printRawSystem(a.printer, a.bytes, list); });
  ipcMain.handle('print:html', async (e, a) => { if (!okWin(e)) throw new Error('مرفوض'); return printHtmlSilent(a.printer, String(a.html || ''), a.widthMm); });
  ipcMain.handle('app:openExternal', async (e, url) => { if (okWin(e) && /^https?:\/\//.test(String(url))) await shell.openExternal(String(url)); });
  ipcMain.handle('app:fullscreen', e => { if (okWin(e) && win) win.setFullScreen(!win.isFullScreen()); return !!(win && win.isFullScreen()); });
  ipcMain.handle('app:reload', e => { if (okWin(e) && win) win.loadURL(APP_URL); });
}

// Once a day: is there a newer desktop shell on the releases page? Only a notice; the person decides.
async function checkShellUpdate() {
  try {
    const last = Number(fs.existsSync(path.join(app.getPath('userData'), 'update-check')) ? fs.readFileSync(path.join(app.getPath('userData'), 'update-check'), 'utf8') : 0);
    if (Date.now() - last < 20 * 3600 * 1000) return;
    fs.writeFileSync(path.join(app.getPath('userData'), 'update-check'), String(Date.now()));
    const r = await net.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } }); if (!r.ok) return;
    const rel = await r.json(); const tag = String(rel.tag_name || '').replace(/^desktop-v|^v/, '');
    const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; } return false; };
    if (!/^\d+\.\d+\.\d+$/.test(tag) || !newer(tag, app.getVersion()) || !win) return;
    const res = await dialog.showMessageBox(win, { type: 'info', message: 'نسخة جديدة من تطبيق الكمبيوتر (' + tag + ')', detail: 'بياناتك لا تتأثر. التنزيل من صفحة الإصدارات ثم التثبيت فوق النسخة الحالية.', buttons: ['تنزيل', 'لاحقًا'], cancelId: 1, noLink: true });
    if (res.response === 0) shell.openExternal(rel.html_url || RELEASES_PAGE);
  } catch (e) { /* offline or rate limited: try another day */ }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tpl = [
    ...(isMac ? [{ label: 'ريڤو', submenu: [{ role: 'about', label: 'عن ريڤو' }, { type: 'separator' }, { role: 'hide', label: 'إخفاء' }, { role: 'hideOthers', label: 'إخفاء الباقي' }, { role: 'unhide', label: 'إظهار الكل' }, { type: 'separator' }, { role: 'quit', label: 'إنهاء ريڤو' }] }] : []),
    { label: 'تحرير', submenu: [{ role: 'undo', label: 'تراجع' }, { role: 'redo', label: 'إعادة' }, { type: 'separator' }, { role: 'cut', label: 'قص' }, { role: 'copy', label: 'نسخ' }, { role: 'paste', label: 'لصق' }, { role: 'selectAll', label: 'تحديد الكل' }] },
    { label: 'عرض', submenu: [{ label: 'إعادة التحميل', accelerator: 'CmdOrCtrl+R', click: () => win && win.loadURL(APP_URL) }, { role: 'togglefullscreen', label: 'ملء الشاشة' }, { type: 'separator' }, { role: 'zoomIn', label: 'تكبير' }, { role: 'zoomOut', label: 'تصغير' }, { role: 'resetZoom', label: 'الحجم الطبيعي' }, { type: 'separator' }, { role: 'toggleDevTools', label: 'أدوات المطوّر' }] },
    { label: 'نافذة', submenu: [{ role: 'minimize', label: 'تصغير النافذة' }, ...(isMac ? [{ role: 'zoom', label: 'تكبير النافذة' }, { type: 'separator' }, { role: 'front', label: 'إحضار الكل للأمام' }] : [{ role: 'close', label: 'إغلاق' }])] },
    { label: 'مساعدة', submenu: [{ label: 'موقع ريڤو', click: () => shell.openExternal(APP_ORIGIN + new URL(APP_URL).pathname.replace(/app\/$/, '')) }, { label: 'صفحة الإصدارات', click: () => shell.openExternal(RELEASES_PAGE) }, { type: 'separator' }, { label: 'الإصدار ' + app.getVersion(), enabled: false }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('web-contents-created', (e, wc) => { wc.on('will-attach-webview', ev => ev.preventDefault()); });
app.whenReady().then(() => {
  setupPermissions(session.defaultSession); setupIpc(); buildMenu(); createWindow();
  setTimeout(checkShellUpdate, 25000);
});

// Printing from the desktop app, without any native module:
//  - network printers: the ESC/POS bytes go straight to the printer over TCP (port 9100, the "raw" port every receipt printer listens on)
//  - printers installed on this computer (Windows or macOS driver): the same bytes go to the driver as RAW data
//    (Windows: the spooler's WritePrinter through a small PowerShell helper; macOS and Linux: CUPS `lp -o raw`)
//  - probe: is the network printer answering right now?
// Every error carries a short Arabic message the app shows as it is.
const net = require('net'); const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawn } = require('child_process');

const MSG = {
  refused: 'الطابعة لا تستجيب على هذا العنوان والمنفذ. تأكد من العنوان ومن أنها على نفس الشبكة',
  timeout: 'انتهت مهلة الاتصال بالطابعة. تأكد من أنها مشغّلة وموصولة بالشبكة',
  host: 'عنوان الطابعة غير صحيح',
  noPrinter: 'لم تُعثر على طابعة بهذا الاسم على هذا الكمبيوتر',
  raw: 'رفض تعريف الطابعة البيانات. جرّب «طباعة عبر التعريف» من إعدادات الطابعة',
  tool: 'تعذّر تشغيل أداة الطباعة على هذا الكمبيوتر',
};

const toBuffer = b => (Buffer.isBuffer(b) ? b : b instanceof Uint8Array ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : Buffer.from(b));

// TCP raw printing. Succeeds as soon as the printer has taken all the bytes (some printers keep the line open for a while
// afterwards, which must not turn a printed paper into a "failed" one). A printer that is off is reported within 3 seconds.
function sendNet(host, port, buf, timeoutMs) {
  const p = Number(port) || 9100; const total = timeoutMs || 12000; const connectMs = Math.min(3000, total);
  return new Promise((resolve, reject) => {
    if (!host || !/^[\w.-]+$/.test(String(host))) return reject(new Error(MSG.host));
    const s = new net.Socket(); let done = false, sent = false; let grace = null;
    const end = (err) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(grace); s.destroy(); err ? reject(err) : resolve({ bytes: buf.length }); };
    let timer = setTimeout(() => end(new Error(MSG.timeout)), connectMs);
    s.setNoDelay(true);
    s.once('error', e => { if (sent) return end(null); end(new Error(e && (e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' || e.code === 'ENOTFOUND' || e.code === 'EHOSTDOWN') ? MSG.refused : e.code === 'ETIMEDOUT' ? MSG.timeout : 'تعذّر الإرسال إلى الطابعة: ' + (e.code || e.message))); });
    s.connect(p, String(host), () => {
      clearTimeout(timer); timer = setTimeout(() => end(new Error(MSG.timeout)), total);
      s.write(buf, err => {
        if (err) return end(new Error('انقطع الاتصال بالطابعة أثناء الإرسال. تأكد من الكيبل ومن الورق ثم أعد المحاولة'));
        sent = true; s.end();
        grace = setTimeout(() => end(null), 600); // every byte was taken: do not wait for the printer to hang up
      });
    });
    s.once('close', () => end(sent ? null : new Error('أغلقت الطابعة الاتصال قبل استلام الورقة. قد تكون مشغولة بجهاز آخر أو بلا ورق')));
  });
}
// One paper at a time per printer: most receipt printers accept a single connection, so papers for the same printer line up here;
// different printers never wait for each other.
const netLines = new Map();
function printNet(host, port, bytes, timeoutMs) {
  const buf = toBuffer(bytes); const key = String(host) + ':' + (Number(port) || 9100);
  const prev = netLines.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => sendNet(host, port, buf, timeoutMs));
  netLines.set(key, run); run.catch(() => {}).then(() => { if (netLines.get(key) === run) netLines.delete(key); });
  return run;
}

// Is something listening at host:port? Quick connect, then hang up.
// The local networks this computer is on (one /24 per network card), for the printer search.
function localSubnets() {
  const out = []; const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(name => (ifs[name] || []).forEach(a => {
    const v4 = a.family === 'IPv4' || a.family === 4; if (!v4 || a.internal) return;
    const p = String(a.address).split('.').map(Number); if (p.length !== 4 || (p[0] === 169 && p[1] === 254)) return;
    const base = p.slice(0, 3).join('.'); if (!out.some(x => x.base === base)) out.push({ base, self: a.address, name });
  }));
  return out.slice(0, 4);
}
// Search the local network for receipt printers: every address of this computer's networks is tried on the raw printing port
// (9100), many at a time, so the whole search takes two to three seconds. Nothing is sent to the devices found.
async function scanNet(opts) {
  opts = opts || {}; const port = Number(opts.port) || 9100; const timeout = Math.max(150, Math.min(2000, Number(opts.timeoutMs) || 450)); const conc = Math.max(8, Math.min(128, Number(opts.concurrency) || 64));
  const subs = Array.isArray(opts.subnets) && opts.subnets.length ? opts.subnets.map(b => ({ base: String(b), self: '' })) : localSubnets();
  const hosts = [];
  subs.forEach(sn => { for (let i = 1; i < 255; i++) { const h = sn.base + '.' + i; if (h !== sn.self) hosts.push(h); } });
  // factory addresses of common receipt printers, in case the printer was never given an address on this network
  (opts.extra || ['192.168.123.100', '192.168.1.100', '192.168.0.100', '192.168.1.87', '192.168.2.250']).forEach(h => { if (!hosts.includes(h)) hosts.push(h); });
  const found = []; let idx = 0;
  const worker = async () => { while (idx < hosts.length) { const h = hosts[idx++]; const t0 = Date.now(); if (await probe(h, port, timeout)) found.push({ host: h, port, ms: Date.now() - t0 }); } };
  await Promise.all(Array.from({ length: Math.min(conc, hosts.length) }, worker));
  const num = h => h.split('.').reduce((n, x) => n * 256 + Number(x), 0);
  found.sort((a, b) => num(a.host) - num(b.host));
  return { found, scanned: hosts.length, subnets: subs.map(sn => sn.base + '.0/24'), port };
}

function probe(host, port, timeoutMs) {
  return new Promise(resolve => {
    if (!host || !/^[\w.-]+$/.test(String(host))) return resolve(false);
    const s = new net.Socket(); let done = false; const fin = ok => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve(ok); };
    const timer = setTimeout(() => fin(false), timeoutMs || 1500);
    s.once('error', () => fin(false)); s.connect(Number(port) || 9100, String(host), () => fin(true));
  });
}

// The Windows helper: sends a file to a named printer as RAW data through the print spooler (what the vendor tools do).
const PS_RAW = `param([string]$Printer, [string]$File)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.IO; using System.Runtime.InteropServices;
public class ZetoRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFOW { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPWStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW di);
  [DllImport("winspool.drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);
  public static int Send(string printer, byte[] bytes) {
    IntPtr h; DOCINFOW di = new DOCINFOW(); di.pDocName = "Zeto"; di.pDataType = "RAW";
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return 2;
    int rc = 3;
    if (StartDocPrinter(h, 1, di)) {
      if (StartPagePrinter(h)) {
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length); Marshal.Copy(bytes, 0, p, bytes.Length); int w;
        rc = WritePrinter(h, p, bytes.Length, out w) && w == bytes.Length ? 0 : 3;
        Marshal.FreeCoTaskMem(p); EndPagePrinter(h);
      }
      EndDocPrinter(h);
    }
    ClosePrinter(h); return rc;
  }
}
"@
$bytes = [System.IO.File]::ReadAllBytes($File)
$rc = [ZetoRawPrinter]::Send($Printer, $bytes)
exit $rc
`;

// The same helper kept running (Windows): the first paper compiles the small helper once (one to two seconds), every paper
// after that goes out in a few milliseconds. Names and paths travel as base64 so Arabic names survive the pipe.
const PS_WORKER = PS_RAW.replace(/^param\(\[string\]\$Printer, \[string\]\$File\)\r?\n/, '').replace(/\$bytes = \[System\.IO\.File\]::ReadAllBytes\(\$File\)[\s\S]*$/, '') + `
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Split('|')
  if ($parts.Length -lt 3) { continue }
  $rc = 4
  try {
    $printer = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($parts[1]))
    $file = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($parts[2]))
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $rc = [ZetoRawPrinter]::Send($printer, $bytes)
  } catch { $rc = 4 }
  [Console]::Out.WriteLine('DONE|' + $parts[0] + '|' + $rc)
}
`;
let worker = null; // { child, ready: Promise, jobs: Map, buf: '' }
function startWorker() {
  if (process.platform !== 'win32') return null;
  if (worker && !worker.dead) return worker;
  const dir = path.join(os.tmpdir(), 'revo-print'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rawworker.ps1'); fs.writeFileSync(file, '\ufeff' + PS_WORKER, 'utf8');
  const w = { jobs: new Map(), buf: '', dead: false, n: 0 };
  try { w.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { return null; }
  const fail = () => { if (w.dead) return; w.dead = true; w.jobs.forEach(j => j.reject(new Error(MSG.tool))); w.jobs.clear(); if (worker === w) worker = null; };
  w.ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => { fail(); reject(new Error(MSG.tool)); }, 20000);
    w.onReady = () => { clearTimeout(t); resolve(true); };
    w.child.once('error', () => { clearTimeout(t); fail(); reject(new Error(MSG.tool)); });
    w.child.once('exit', () => { clearTimeout(t); fail(); reject(new Error(MSG.tool)); });
  });
  w.ready.catch(() => {});
  w.child.stdout.setEncoding('utf8');
  w.child.stdout.on('data', d => {
    w.buf += d; let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i).trim(); w.buf = w.buf.slice(i + 1);
      if (line === 'READY') { if (w.onReady) w.onReady(); continue; }
      const m = /^DONE\|(\d+)\|(-?\d+)$/.exec(line); if (!m) continue;
      const j = w.jobs.get(m[1]); if (j) { w.jobs.delete(m[1]); clearTimeout(j.timer); j.resolve(Number(m[2])); }
    }
  });
  w.child.stderr.on('data', () => {});
  worker = w; return w;
}
// Returns the helper's result code, or throws when the running helper cannot be used (the caller then starts it the slow way).
async function workerSend(name, file) {
  const w = startWorker(); if (!w) throw new Error(MSG.tool);
  await w.ready;
  return new Promise((resolve, reject) => {
    const id = String(++w.n);
    const timer = setTimeout(() => { w.jobs.delete(id); reject(new Error(MSG.timeout)); }, 30000);
    w.jobs.set(id, { resolve, reject, timer });
    try { w.child.stdin.write(id + '|' + Buffer.from(name, 'utf8').toString('base64') + '|' + Buffer.from(file, 'utf8').toString('base64') + '\n'); }
    catch (e) { clearTimeout(timer); w.jobs.delete(id); reject(new Error(MSG.tool)); }
  });
}
// Start the helper ahead of the first paper, so that one is fast too.
function warmUp() { try { const w = startWorker(); if (w) w.ready.catch(() => {}); } catch (e) { /* the slow way still works */ } }
function shutdown() { try { if (worker && worker.child) worker.child.kill(); } catch (e) { /* gone */ } }

let psPath = null;
function helperPath() {
  if (psPath && fs.existsSync(psPath)) return psPath;
  const dir = path.join(os.tmpdir(), 'revo-print'); fs.mkdirSync(dir, { recursive: true });
  psPath = path.join(dir, 'rawprint.ps1'); fs.writeFileSync(psPath, '﻿' + PS_RAW, 'utf8'); return psPath;
}
function tempFile(buf) {
  const dir = path.join(os.tmpdir(), 'revo-print'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.bin'); fs.writeFileSync(f, buf); return f;
}
function runTool(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '', err = ''; let child;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return reject(new Error(MSG.tool)); }
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } reject(new Error(MSG.timeout)); }, timeoutMs || 30000);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('error', () => { clearTimeout(timer); reject(new Error(MSG.tool)); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// RAW bytes to a printer installed on this computer. `printers` (optional) is the list from Electron, to check the name first.
async function printRawSystem(printerName, bytes, printers) {
  const name = String(printerName || '').trim(); if (!name) throw new Error(MSG.noPrinter);
  if (Array.isArray(printers) && printers.length && !printers.some(p => p.name === name || p.displayName === name)) throw new Error(MSG.noPrinter);
  const buf = toBuffer(bytes); const file = tempFile(buf);
  try {
    if (process.platform === 'win32') {
      // The running helper first (milliseconds); the one-shot helper only if the running one cannot be used.
      let rc = null;
      try { rc = await workerSend(name, file); } catch (e) { rc = null; }
      if (rc === 0) return { bytes: buf.length };
      if (rc === 2) throw new Error(MSG.noPrinter);
      if (rc === 3) throw new Error(MSG.raw);
      const r = await runTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath(), '-Printer', name, '-File', file]);
      if (r.code === 0) return { bytes: buf.length };
      if (r.code === 2) throw new Error(MSG.noPrinter);
      throw new Error(r.code === 3 ? MSG.raw : MSG.tool + (r.err ? ': ' + r.err.trim().split('\n')[0].slice(0, 80) : ''));
    }
    const r = await runTool('lp', ['-d', name, '-o', 'raw', file]);
    if (r.code === 0) return { bytes: buf.length };
    throw new Error(/does not exist|unknown printer|Unknown destination/i.test(r.err) ? MSG.noPrinter : MSG.raw + (r.err ? ': ' + r.err.trim().split('\n')[0].slice(0, 80) : ''));
  } finally { setTimeout(() => { try { fs.unlinkSync(file); } catch (e) { /* already gone */ } }, 15000); }
}

module.exports = { printNet, probe, printRawSystem, scanNet, localSubnets, warmUp, shutdown, MSG, _internal: { toBuffer, helperPath, PS_RAW, PS_WORKER, sendNet } };

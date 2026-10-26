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

// TCP raw printing. Resolves when the printer has taken all the bytes and the connection is closed.
function printNet(host, port, bytes, timeoutMs) {
  const buf = toBuffer(bytes); const p = Number(port) || 9100; const t = timeoutMs || 8000;
  return new Promise((resolve, reject) => {
    if (!host || !/^[\w.-]+$/.test(String(host))) return reject(new Error(MSG.host));
    const s = new net.Socket(); let done = false;
    const end = (err) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); err ? reject(err) : resolve({ bytes: buf.length }); };
    const timer = setTimeout(() => end(new Error(MSG.timeout)), t);
    s.once('error', e => end(new Error(e && (e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' || e.code === 'ENOTFOUND') ? MSG.refused : e.code === 'ETIMEDOUT' ? MSG.timeout : 'تعذّر الإرسال إلى الطابعة: ' + (e.code || e.message))));
    s.connect(p, String(host), () => {
      s.write(buf, err => { if (err) return end(err); s.end(); });
    });
    s.once('close', () => end(null));
  });
}

// Is something listening at host:port? Quick connect, then hang up.
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
public class RevoRawPrinter {
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
    IntPtr h; DOCINFOW di = new DOCINFOW(); di.pDocName = "Revo"; di.pDataType = "RAW";
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
$rc = [RevoRawPrinter]::Send($Printer, $bytes)
exit $rc
`;

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

module.exports = { printNet, probe, printRawSystem, MSG, _internal: { toBuffer, helperPath, PS_RAW } };

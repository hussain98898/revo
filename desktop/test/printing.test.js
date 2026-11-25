// The printing library without Electron: raw bytes reach a fake network printer intact, a dead address fails fast with a
// plain Arabic message, the probe answers true/false, and the Windows helper script is written once with a BOM.
const net = require('net'); const assert = require('assert'); const fs = require('fs');
const P = require('../lib/printing');
(async () => {
  let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
  // a fake ESC/POS printer: collects everything it receives
  const got = []; const srv = net.createServer(s => { const chunks = []; s.on('data', d => chunks.push(d)); s.on('end', () => got.push(Buffer.concat(chunks))); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const bytes = new Uint8Array(70000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251; bytes[0] = 0x1b; bytes[1] = 0x40;
  const r = await P.printNet('127.0.0.1', port, bytes);
  await new Promise(r => setTimeout(r, 50));
  ok(r.bytes === 70000 && got.length === 1 && got[0].length === 70000 && got[0].equals(Buffer.from(bytes)), 'a 70 KB job arrives at the network printer byte for byte');
  ok(await P.probe('127.0.0.1', port) === true, 'probe: a listening printer answers true');
  srv.close();
  const dead = await P.probe('127.0.0.1', port); ok(dead === false, 'probe: a closed port answers false');
  let msg = ''; try { await P.printNet('127.0.0.1', port, bytes); } catch (e) { msg = e.message; }
  ok(msg === P.MSG.refused, 'refused connection gives the plain message: ' + msg);
  msg = ''; try { await P.printNet('bad host!', 9100, bytes); } catch (e) { msg = e.message; }
  ok(msg === P.MSG.host, 'bad host name is refused before connecting');
  // timeout: a server that accepts but never reads (tiny backlog, full buffer) is hard to fake portably; check the timer path with 1 ms on a black-hole address
  msg = ''; const t0 = Date.now(); try { await P.printNet('10.255.255.1', 9100, bytes, 400); } catch (e) { msg = e.message; }
  ok((msg === P.MSG.timeout || msg === P.MSG.refused) && Date.now() - t0 < 3000, 'unreachable address fails within the time limit: ' + msg);
  const h = P._internal.helperPath(); const txt = fs.readFileSync(h, 'utf8');
  ok(txt.charCodeAt(0) === 0xfeff && /WritePrinter/.test(txt) && /pDataType = "RAW"/.test(txt), 'Windows helper written with a BOM and the RAW spooler calls');
  ok(P._internal.helperPath() === h, 'helper path is reused');
  msg = ''; try { await P.printRawSystem('', bytes); } catch (e) { msg = e.message; }
  ok(msg === P.MSG.noPrinter, 'empty printer name is refused');
  msg = ''; try { await P.printRawSystem('Ghost', bytes, [{ name: 'XP-80C' }]); } catch (e) { msg = e.message; }
  ok(msg === P.MSG.noPrinter, 'a name not in the installed list is refused without calling the tool');
  // a printer that takes the paper but never hangs up: still a success, and quickly
  const lazy = net.createServer({ allowHalfOpen: true }, s => { s.on('data', () => {}); /* never hangs up */ }); await new Promise(r => lazy.listen(0, '127.0.0.1', r));
  let t1 = Date.now(); const rl = await P.printNet('127.0.0.1', lazy.address().port, bytes); let dtl = Date.now() - t1;
  ok(rl.bytes === 70000 && dtl >= 500 && dtl < 2000, 'a printer that keeps the line open is not reported as failed (' + dtl + ' ms)');
  // a printer that is switched off (nothing answers): reported within about 3 seconds, not 8
  t1 = Date.now(); msg = ''; try { await P.printNet('10.255.255.1', 9100, bytes); } catch (e) { msg = e.message; }
  ok((msg === P.MSG.timeout || msg === P.MSG.refused) && Date.now() - t1 < 3600, 'a switched-off printer fails in ' + (Date.now() - t1) + ' ms: ' + msg);
  // several printers at once: each has its own line; papers for one printer keep their order
  const mk = async delay => { const seen = []; const sv = net.createServer(s => { const ch = []; s.on('data', d => ch.push(d)); s.on('end', () => setTimeout(() => { seen.push(Buffer.concat(ch)[0]); s.end(); }, delay)); }); sv.on('connection', s => s.setTimeout(0)); await new Promise(r => sv.listen(0, '127.0.0.1', r)); return { sv, seen, port: sv.address().port }; };
  const slow = await mk(250), fast1 = await mk(0), fast2 = await mk(0);
  const job = n => Uint8Array.from([n, 2, 3, 4]);
  t1 = Date.now();
  const all = [P.printNet('127.0.0.1', slow.port, job(1)), P.printNet('127.0.0.1', slow.port, job(2)), P.printNet('127.0.0.1', slow.port, job(3)), P.printNet('127.0.0.1', fast1.port, job(7)), P.printNet('127.0.0.1', fast2.port, job(8))];
  const tf = Date.now(); await Promise.all(all.slice(3)); const fastMs = Date.now() - tf;
  await Promise.all(all); await new Promise(r => setTimeout(r, 400));
  ok(fastMs < 200, 'two other printers finished in ' + fastMs + ' ms while the first one was busy');
  ok(slow.seen.join(',') === '1,2,3', 'three papers for one printer arrive one after another, in order: ' + slow.seen.join(','));
  ok(fast1.seen[0] === 7 && fast2.seen[0] === 8, 'each printer got its own paper');
  // the printer search: every address of the given network is tried on the port; the listening one is found, nothing is sent
  const quiet = []; const target = net.createServer(s => { s.on('data', d => quiet.push(d)); }); await new Promise(r => target.listen(0, '127.0.0.1', r));
  t1 = Date.now(); const sc = await P.scanNet({ subnets: ['127.0.0'], port: target.address().port, timeoutMs: 300, extra: [] });
  ok(sc.scanned >= 254 && sc.found.some(x => x.host === '127.0.0.1') && Date.now() - t1 < 6000, 'search: ' + sc.scanned + ' addresses in ' + (Date.now() - t1) + ' ms, found ' + sc.found.map(x => x.host).join(', '));
  ok(quiet.length === 0, 'search sends nothing to the devices it finds');
  ok(Array.isArray(P.localSubnets()), 'local networks are listed: ' + P.localSubnets().map(x => x.base).join(', '));
  [lazy, slow.sv, fast1.sv, fast2.sv, target].forEach(x => { try { x.close(); } catch (e) { /* closed */ } });
  // the running Windows helper: same spooler calls, a line protocol, names as base64
  const W = P._internal.PS_WORKER;
  ok(/public static int Send/.test(W) && /"@\s*\n\s*\[Console\]::Out\.WriteLine\('READY'\)/.test(W) && /FromBase64String/.test(W) && !/^param\(/m.test(W) && !/exit \$rc/.test(W), 'the running helper keeps the spooler code, announces READY and loops on lines');
  for (const [k, v] of Object.entries(P.MSG)) ok(!v.includes('\u2014'), 'no em dash in message ' + k);
  P.shutdown(); console.log(fails ? fails + ' failure(s)' : 'all ok'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

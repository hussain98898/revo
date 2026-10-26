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
  for (const [k, v] of Object.entries(P.MSG)) ok(!v.includes('—'), 'no em dash in message ' + k);
  console.log(fails ? fails + ' failure(s)' : 'all ok'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

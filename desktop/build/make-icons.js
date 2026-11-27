// Renders the computer app's icons from the shared mark. Run: node desktop/build/make-icons.js
// icon.png (1024 px): the Mac icon, on the Mac icon grid (the square takes 824 of 1024 and has the Mac corner).
// icon.ico: the Windows icon, seven sizes drawn one by one (16 to 256) so the small ones stay sharp.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs'); const { markSvg } = require('../../cloud/mark');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
  const shot = async (size, o) => { await p.setViewportSize({ width: size, height: size }); await p.setContent('<!doctype html><html><body style="margin:0;background:transparent">' + markSvg(size, o) + '</body></html>'); return p.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }); };
  fs.writeFileSync(path.join(__dirname, 'icon.png'), await shot(1024, { pad: 0.098, r: 0.225 }));
  // Windows shows icons edge to edge: no margin at the small sizes, a hair at the large ones.
  const sizes = [16, 24, 32, 48, 64, 128, 256]; const pngs = [];
  for (const s of sizes) pngs.push(await shot(s, { pad: s >= 64 ? 0.03 : 0, r: 0.24 }));
  // An .ico file: a 6-byte header, one 16-byte entry per size, then the pictures (PNG inside, as Windows has read since Vista).
  const head = Buffer.alloc(6 + 16 * sizes.length); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let at = head.length;
  sizes.forEach((s, i) => { const e = 6 + 16 * i; head.writeUInt8(s === 256 ? 0 : s, e); head.writeUInt8(s === 256 ? 0 : s, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3); head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(at, e + 12); at += pngs[i].length; });
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([head].concat(pngs)));
  await b.close(); console.log('desktop/build/icon.png and icon.ico written');
})();

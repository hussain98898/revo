// Renders desktop/build/icon.png (1024 px, the same mark as the web app icons). Run once: node desktop/build/make-icons.js
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1100, height: 1100 } });
  await p.setContent('<!doctype html><html><body style="margin:0;background:#fff"><canvas id="c"></canvas></body></html>');
  const png = await p.evaluate(async () => {
    const s = document.createElement('canvas'); s.width = 1400; s.height = 1400; const g = s.getContext('2d');
    g.fillStyle = '#000'; g.font = 'bold 840px "DejaVu Sans", sans-serif'; g.textBaseline = 'alphabetic'; g.textAlign = 'center'; g.fillText('ر', 700, 910);
    const d = g.getImageData(0, 0, 1400, 1400).data; let x0 = 1400, y0 = 1400, x1 = 0, y1 = 0;
    for (let y = 0; y < 1400; y++) for (let x = 0; x < 1400; x++) { if (d[(y * 1400 + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    const iw = x1 - x0 + 1, ih = y1 - y0 + 1;
    const size = 1024, pad = 80, radius = 200; const c = document.getElementById('c'); c.width = size; c.height = size; const ctx = c.getContext('2d');
    const inner = size - 2 * pad; const grad = ctx.createLinearGradient(pad, pad, size - pad, size - pad); grad.addColorStop(0, '#1a7bff'); grad.addColorStop(1, '#0052c7');
    ctx.fillStyle = grad; ctx.beginPath(); ctx.roundRect(pad, pad, inner, inner, radius); ctx.fill();
    const target = inner * 0.5; const scale = Math.min(target / iw, target / ih); const dw = iw * scale, dh = ih * scale;
    ctx.drawImage(s, x0, y0, iw, ih, pad + (inner - dw) / 2, pad + (inner - dh) / 2 - inner * 0.02, dw, dh);
    const img = ctx.getImageData(0, 0, size, size); const q = img.data;
    for (let i = 0; i < q.length; i += 4) { if (q[i] < 60 && q[i + 1] < 60 && q[i + 2] < 60 && q[i + 3] > 0) { q[i] = 255; q[i + 1] = 255; q[i + 2] = 255; } }
    ctx.putImageData(img, 0, 0); return c.toDataURL('image/png');
  });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), Buffer.from(png.split(',')[1], 'base64'));
  await b.close(); console.log('desktop/build/icon.png written');
})();

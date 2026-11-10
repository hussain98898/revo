// Renders desktop/build/icon.png (1024 px) from the shared mark. Run once: node desktop/build/make-icons.js, then icon.ico with Pillow (see README).
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs'); const { markSvg } = require('../../cloud/mark');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
  await p.setContent('<!doctype html><html><body style="margin:0;background:transparent">' + markSvg(1024, { pad: 0.08 }) + '</body></html>');
  fs.writeFileSync(path.join(__dirname, 'icon.png'), await p.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } }));
  await b.close(); console.log('desktop/build/icon.png written');
})();

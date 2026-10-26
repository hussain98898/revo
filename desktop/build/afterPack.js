// macOS: an app with no signature at all does not start on Apple Silicon, so the packed app gets an ad-hoc signature
// (no certificate needed). Gatekeeper still shows the first-run notice; the site explains how to open it.
// Only the final universal app is signed: signing the x64 and arm64 halves first would make their files differ,
// and the universal merge refuses halves that differ (the "-temp" folders are those halves).
const { execSync } = require('child_process'); const path = require('path'); const fs = require('fs');
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (/-temp$/.test(context.appOutDir)) return;
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  if (!fs.existsSync(appPath)) return;
  execSync('codesign --force --deep --sign - ' + JSON.stringify(appPath), { stdio: 'inherit' });
  try { execSync('codesign --verify --deep --strict ' + JSON.stringify(appPath), { stdio: 'inherit' }); }
  catch (e) { console.warn('afterPack: ad-hoc signature could not be verified, continuing'); }
};

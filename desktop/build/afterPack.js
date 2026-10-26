// macOS: an app with no signature at all does not start on Apple Silicon, so the packed app gets an ad-hoc signature
// (no certificate needed). Gatekeeper still shows the first-run notice; the site explains how to open it.
const { execSync } = require('child_process'); const path = require('path'); const fs = require('fs');
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  if (!fs.existsSync(appPath)) return;
  execSync('codesign --force --deep --sign - ' + JSON.stringify(appPath), { stdio: 'inherit' });
  execSync('codesign --verify --deep --strict ' + JSON.stringify(appPath), { stdio: 'inherit' });
};

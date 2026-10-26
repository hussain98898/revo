// Remembers the window's size, position and full-screen state between runs (a small JSON file in the app's data folder).
const fs = require('fs'); const path = require('path');

function windowState(userDataDir, defaults) {
  const file = path.join(userDataDir, 'window-state.json');
  let st = Object.assign({ width: 1280, height: 820, fullscreen: false, maximized: false }, defaults || {});
  try { st = Object.assign(st, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* first run */ }
  let timer = null;
  const save = () => { try { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(st)); } catch (e) { /* not fatal */ } };
  return {
    get: () => st,
    // Call with the BrowserWindow once it exists: tracks resize/move and writes the file a moment after the last change.
    track(win) {
      const upd = () => {
        if (win.isDestroyed()) return;
        st.maximized = win.isMaximized(); st.fullscreen = win.isFullScreen();
        if (!st.maximized && !st.fullscreen) { const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds(); st.x = b.x; st.y = b.y; st.width = b.width; st.height = b.height; }
        clearTimeout(timer); timer = setTimeout(save, 400);
      };
      ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach(ev => win.on(ev, upd));
      win.on('close', () => { upd(); clearTimeout(timer); save(); });
    },
  };
}
module.exports = { windowState };

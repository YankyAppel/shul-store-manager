import { app, BrowserWindow } from 'electron';
import path from 'node:path';
app.whenReady().then(() => {
  const w = new BrowserWindow({
    fullscreen: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  void w.loadFile(path.join(import.meta.dirname, '../dist/index.html'));
});

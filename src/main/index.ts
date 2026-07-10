import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { execFile } from 'child_process'
import os from 'node:os';

function getDns(interfaceName: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "netsh",
      ["interface", "ip", "show", "dns", interfaceName],
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        if (stderr) {
          reject(new Error(stderr));
          return;
        }

        const dns = stdout.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];

        resolve(dns);
      }
    );
  });
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.handle('proxy', () => {
    return new Promise((resolve, reject) => {
      execFile(
        "reg",
        [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
          "/v",
          "ProxyEnable",
        ],
        (err, stdout) => {
          if (err) return reject(err);

          let status: boolean = stdout.split(" ")[stdout.split(" ").length - 1].includes("0x1") ? true : false;
          resolve(status);
        }
      );
    });
  })
  ipcMain.handle('dns', async () => {
    const wifi = await getDns("Wi-Fi");
    const ethernet = await getDns("vEthernet (Default Switch)");

    return {
      wifi,
      ethernet,
    };
  })
  ipcMain.handle('proxy-server', () => {
    return new Promise((resolve, reject) => {
      execFile(
        "reg",
        [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
          "/v",
          "ProxyServer",
        ],
        (err, stdout) => {
          if (err) return reject(err);

          let status: string = stdout.split(" ")[stdout.split(" ").length - 1];
          resolve(status);
        }
      );
    });
  })
  ipcMain.handle('vpn', () => {
    console.log(os.networkInterfaces())
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec: execCmd } = require('child_process');
const SECRET_SALT = "CROMA_SECURE_2024";

if (app.isPackaged) {
    console.log = () => {};
    console.debug = () => {};
    console.info = () => {};
}

const db = require('./db');

// Helper to get HWID
function getMachineId() {
    return new Promise((resolve) => {
        execCmd('wmic csproduct get uuid', (err, stdout) => {
            if (err) return resolve("UNKNOWN-MACHINE-ID");
            const lines = stdout.split('\n');
            const uuid = lines[1] ? lines[1].trim() : "UNKNOWN-MACHINE-ID";
            resolve(uuid);
        });
    });
}

// Generate valid key for a machine ID
function generateKey(machineId) {
    return crypto.createHash('sha256').update(machineId + SECRET_SALT).digest('hex').substring(0, 16).toUpperCase();
}

// Force the native system print dialog by disabling the Chromium print preview
app.commandLine.appendSwitch('disable-print-preview');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// --- IPC HANDLERS ---
ipcMain.handle('is-packaged', () => app.isPackaged);

ipcMain.handle('get-activation-status', async () => {
    const machineId = await getMachineId();
    const result = await new Promise((resolve) => {
        db.get("SELECT key FROM license", (err, row) => resolve(row));
    });
    
    if (!result) return { activated: false, requestId: machineId };
    
    const expectedKey = generateKey(machineId);
    if (result.key === expectedKey) {
        return { activated: true };
    } else {
        return { activated: false, requestId: machineId };
    }
});

ipcMain.handle('activate-app', async (event, enteredKey) => {
    const machineId = await getMachineId();
    const expectedKey = generateKey(machineId);
    
    if (enteredKey.trim().toUpperCase() === expectedKey) {
        await new Promise((resolve) => {
            db.run("INSERT INTO license (key, activated_at) VALUES (?, CURRENT_TIMESTAMP)", [expectedKey], () => resolve());
        });
        return { success: true };
    } else {
        return { success: false };
    }
});

ipcMain.handle('db-get', async (event, sql, params) => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
});

ipcMain.handle('db-all', async (event, sql, params) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
});

ipcMain.handle('db-run', async (event, sql, params) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
});

ipcMain.handle('db-exec', async (event, sql) => {
    return new Promise((resolve, reject) => {
        db.exec(sql, (err) => err ? reject(err) : resolve());
    });
});

ipcMain.handle('db-restore', async (event, backupPath) => {
    try {
        const dbPath = path.join(app.getPath('userData'), 'database.db');
        await db.close();
        fs.copyFileSync(backupPath, dbPath);
        event.sender.send('restore-success');
        app.relaunch();
        app.exit(0);
        return { success: true };
    } catch (err) {
        console.error("RESTORE ERROR:", err);
        throw err;
    }
});

function logCrash(error) {
    const logPath = path.join(app.getPath('userData'), 'crash_report.txt');
    const msg = `[${new Date().toISOString()}] ${error.stack || error}\n`;
    if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, "");
    fs.appendFileSync(logPath, msg);
    console.error("CRASH LOGGED:", error);
}

function createWindow() {
    try {
        const win = new BrowserWindow({
            width: 1200,
            height: 900,
            show: false, 
            backgroundColor: '#111827',
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                webSecurity: false,
                devTools: !app.isPackaged
            }
        });

        win.loadFile('index.html').catch(logCrash);
        win.once('ready-to-show', () => win.show());
        win.setMenuBarVisibility(false);
        if (!app.isPackaged) win.webContents.openDevTools();

        win.webContents.on('render-process-gone', (event, details) => {
            logCrash(`Renderer Process Gone: ${details.reason} (${details.exitCode})`);
        });
    } catch (e) {
        logCrash(e);
    }
}

ipcMain.handle('print-html', async (event, html) => {
    let printWin = new BrowserWindow({
        show: false,
        width: 1000,
        height: 800,
        title: 'Croma Tailors - Print Preview',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            devTools: !app.isPackaged
        }
    });

    if (app.isPackaged) printWin.setMenuBarVisibility(false);
    printWin.once('ready-to-show', () => {
        printWin.show();
        printWin.focus();
    });

    const base64Html = Buffer.from(html).toString('base64');
    printWin.loadURL(`data:text/html;charset=utf-8;base64,${base64Html}`);
    return true;
});

ipcMain.on('trigger-final-print', (event) => {
    const webContents = event.sender;
    webContents.print({
        silent: false,
        printBackground: true,
        deviceName: '',
        pageSize: 'A5',
        margins: { marginType: 'none' },
        landscape: false
    }, (success) => {
        if (success) {
            const win = BrowserWindow.fromWebContents(webContents);
            if (win) win.close();
        }
    });
});

ipcMain.handle("print-slip", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.webContents.print({
        silent: false,
        printBackground: true,
        useSystemDialog: true
    });
    return true;
});

// --- APP READY ---
app.whenReady().then(async () => {
    try {
        await db.initialize();
        createWindow();
    } catch (err) {
        logCrash(err);
        createWindow();
    }
}).catch(logCrash);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

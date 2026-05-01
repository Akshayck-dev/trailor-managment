const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { app } = require('electron');

if (app.isPackaged) {
    console.log = () => {};
    console.debug = () => {};
    console.info = () => {};
}

// Use userData for packaged apps (app.asar is read-only), fallback to __dirname for development
const fs = require('fs');
const dbDir = app.isPackaged
    ? path.join(app.getPath('userData'), 'electron_data')
    : path.join(__dirname, 'electron_data');
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'database.db');
console.log("Database initialized at:", dbPath);

const db = new sqlite3.Database(dbPath);

// --- PROMISE WRAPPERS ---
const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { if (err) reject(err); else resolve(this); });
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
});
const exec = (sql) => new Promise((resolve, reject) => {
    db.exec(sql, (err) => { if (err) reject(err); else resolve(); });
});

// --- SAFETY & MIGRATION ---
function preMigrationBackup() {
    const os = require("os");
    const dir = path.join(os.homedir(), "Documents", "TailorBackup");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const file = path.join(dir, `pre_migration_${new Date().toISOString().slice(0,10)}.db`);
    if (fs.existsSync(file)) {
        console.log("Pre-migration backup already exists for today:", file);
        return;
    }
    // SQLite VACUUM INTO for a safe live snapshot
    try {
        db.exec(`VACUUM INTO '${file}'`, (e) => {
            if (e) {
                if (e.message && e.message.includes("already exists")) {
                    console.log("Pre-migration backup already present for today (Skipping).");
                } else {
                    console.error("Pre-migration backup failed:", e);
                }
            } else {
                console.log("Pre-migration backup created:", file);
            }
        });
    } catch (err) {
        console.error("Backup execution error (caught):", err.message);
    }
}

async function addColumn(tableName, colName, colType) {
    const cols = await all(`PRAGMA table_info(${tableName})`);
    if (!cols.find(c => c.name.toLowerCase() === colName.toLowerCase())) {
        console.log(`Phase 1: Adding ${colName} to ${tableName}`);
        try {
            await run(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colType}`);
        } catch (e) {
            console.warn(`Could not add column ${colName} to ${tableName} (might already exist):`, e.message);
        }
    }
}

// Final Step: Ensure Phase 1 columns exist even on established DBs
async function finalizePhase1Schema() {
    // Shirt
    await addColumn("shirt_measurements", "chest_correct", "TEXT");
    await addColumn("shirt_measurements", "hip_round", "TEXT");
    await addColumn("shirt_measurements", "seat_round", "TEXT");
    await addColumn("shirt_measurements", "apple_cut", "TEXT");
    await addColumn("shirt_measurements", "sleeve_height", "TEXT");
    await addColumn("shirt_measurements", "bicep_round", "TEXT");
    await addColumn("shirt_measurements", "cuff_round_finish", "TEXT");
    await addColumn("shirt_measurements", "front_patti_style", "TEXT");
    await addColumn("shirt_measurements", "shirt_bottom_type", "TEXT");
    
    // Pant
    await addColumn("pant_measurements", "height", "TEXT");
    await addColumn("pant_measurements", "mobile_pocket", "TEXT");
    await addColumn("pant_measurements", "watch_pocket", "TEXT");
}


async function migrateToSpecializedTables() {
    return new Promise((resolve) => {
        db.serialize(() => {
            // 1. Create specialized tables with UNIQUE customer_id
            db.run(`CREATE TABLE IF NOT EXISTS shirt_measurements (
                id INTEGER PRIMARY KEY,
                customer_id INTEGER UNIQUE,
                length TEXT, chest TEXT, chest_correct TEXT,
                hip TEXT, hip_round TEXT,
                seat TEXT, seat_round TEXT,
                shoulder TEXT,
                sleeve_height TEXT, bicep_round TEXT, cuff_round_finish TEXT,
                neck TEXT, cuff_height TEXT, fit_style TEXT, 
                front_patti_style TEXT, shirt_bottom_type TEXT, apple_cut TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS pant_measurements (
                id INTEGER PRIMARY KEY,
                customer_id INTEGER UNIQUE,
                height TEXT, waist TEXT, seat_pant TEXT, thigh TEXT, 
                knee_loose TEXT, bottom_loose TEXT, zip_length TEXT, 
                in_seam TEXT, pant_type TEXT, pocket_type TEXT, 
                back_pocket TEXT, mobile_pocket TEXT, watch_pocket TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // 1.5 Ensure UNIQUE constraint for ON CONFLICT
            db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_shirt_cust_id ON shirt_measurements(customer_id)`);
            db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pant_cust_id ON pant_measurements(customer_id)`);

            // 2. Perform idempotent migration
            db.all(`SELECT * FROM measurements`, [], (err, rows) => {
                if (err || !rows) return resolve();

                rows.forEach(r => {
                    // Shirt UPSERT
                    db.run(`
                        INSERT INTO shirt_measurements (
                            customer_id, length, chest_correct, hip_round, seat_round, shoulder, sleeve_height, bicep_round, cuff_round_finish, neck, cuff_height, fit_style, front_patti_style, apple_cut
                        )
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(customer_id) DO UPDATE SET
                            length=COALESCE(excluded.length, length),
                            chest_correct=COALESCE(excluded.chest_correct, chest_correct),
                            hip_round=COALESCE(excluded.hip_round, hip_round),
                            seat_round=COALESCE(excluded.seat_round, seat_round),
                            shoulder=COALESCE(excluded.shoulder, shoulder),
                            sleeve_height=COALESCE(excluded.sleeve_height, sleeve_height),
                            bicep_round=COALESCE(excluded.bicep_round, bicep_round),
                            cuff_round_finish=COALESCE(excluded.cuff_round_finish, cuff_round_finish),
                            neck=COALESCE(excluded.neck, neck),
                            cuff_height=COALESCE(excluded.cuff_height, cuff_height),
                            fit_style=COALESCE(excluded.fit_style, fit_style),
                            front_patti_style=COALESCE(excluded.front_patti_style, front_patti_style),
                            apple_cut=COALESCE(excluded.apple_cut, apple_cut),
                            updated_at=CURRENT_TIMESTAMP
                    `, [
                        r.customer_id,
                        r.length, r.chest_correct || r.chest, r.hip_round || r.hip,
                        r.seat_round || r.seat,
                        r.shoulder, r.sleeve_height || r.sleeve, r.bicep_round || r.bicep,
                        r.cuff_round_finish || r.cuff_round || r.cuff, r.neck, r.cuff_height,
                        r.fit_style, r.front_patti_style || r.front_patti, r.apple_cut || r.shirt_bottom_type || r.bottom_type
                    ]);

                    // Pant UPSERT
                    db.run(`
                        INSERT INTO pant_measurements (
                            customer_id, height, waist, seat_pant, thigh, knee_loose, bottom_loose, zip_length, in_seam, pant_type, pocket_type, back_pocket, mobile_pocket, watch_pocket
                        )
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(customer_id) DO UPDATE SET
                            height=COALESCE(excluded.height, height),
                            waist=COALESCE(excluded.waist, waist),
                            seat_pant=COALESCE(excluded.seat_pant, seat_pant),
                            thigh=COALESCE(excluded.thigh, thigh),
                            knee_loose=COALESCE(excluded.knee_loose, knee_loose),
                            bottom_loose=COALESCE(excluded.bottom_loose, bottom_loose),
                            zip_length=COALESCE(excluded.zip_length, zip_length),
                            in_seam=COALESCE(excluded.in_seam, in_seam),
                            pant_type=COALESCE(excluded.pant_type, pant_type),
                            pocket_type=COALESCE(excluded.pocket_type, pocket_type),
                            back_pocket=COALESCE(excluded.back_pocket, back_pocket),
                            mobile_pocket=COALESCE(excluded.mobile_pocket, mobile_pocket),
                            watch_pocket=COALESCE(excluded.watch_pocket, watch_pocket),
                            updated_at=CURRENT_TIMESTAMP
                    `, [
                        r.customer_id,
                        r.height, r.waist, r.seat || r.seat_pant,
                        r.thigh, r.knee_loose, r.bottom_loose,
                        r.zip_length, r.in_seam,
                        r.pant_type, r.pocket_type,
                        r.back_pocket, r.mobile_pocket, r.watch_pocket
                    ]);
                });
                console.log("Divergent migration to specialized tables complete.");
                resolve();
            });
        });
    });
}

// --- INITIALIZATION GATE ---
async function initialize() {
    try {
        // 1. Tuning
        await exec(`
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;
        `);

        // 2. Base Tables
        await run(`CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        await run(`CREATE TABLE IF NOT EXISTS measurements (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, type TEXT, length TEXT, chest TEXT, shoulder TEXT, sleeve TEXT, UNIQUE(customer_id, type), FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE)`);
        await run(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, total REAL DEFAULT 0, FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE)`);
        await run(`CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, item_type TEXT, quantity INTEGER, price REAL, amount REAL, FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE)`);
        await run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
        await run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('bill_counter', '0')`);
        await run(`CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, amount REAL, payment_date DATETIME DEFAULT CURRENT_TIMESTAMP, payment_mode TEXT, FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE)`);
        await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)`);
        await run(`CREATE TABLE IF NOT EXISTS license (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, activated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

        // 3. Schema Upgrades
        await upgradeSchema();

        // 4. Data Repair
        await repairLegacyOrders();

        // 5. Specialized Table Migration & Phase 1 Support
        preMigrationBackup();
        await migrateToSpecializedTables(); // Creates dual tables if missing
        await finalizePhase1Schema();      // Adds new columns (chest_correct, hip_round, etc.)
        // performSafeColumnMigration removed - redundant and incorrect in current schema

        console.log("Database Hardening & Specialized Migration Complete");
    } catch (err) {
        console.error("CRITICAL DATABASE INITIALIZATION ERROR:", err);
    }
}

async function repairLegacyOrders() {
    try {
        await run(`
            UPDATE orders 
            SET bill_number = 'LEGACY-' || id 
            WHERE bill_number IS NULL OR TRIM(bill_number) = ''
        `);
    } catch (e) {
        console.error("Data repair failed:", e.message);
    }
}

async function upgradeSchema() {
    // Orders
    const orderCols = {
        "bill_number": "TEXT", "advance": "REAL DEFAULT 0", "balance": "REAL DEFAULT 0",
        "given_date": "TEXT", "delivery_date": "TEXT", "notes": "TEXT",
        "shirt_notes": "TEXT", "pant_notes": "TEXT",
        "status": "TEXT DEFAULT 'PENDING'",
        "payment_mode": "TEXT", "final_payment": "REAL DEFAULT 0"
    };
    await migrateTable("orders", orderCols);
    
    // Customers
    await addColumn("customers", "created_at", "DATETIME DEFAULT CURRENT_TIMESTAMP");

    const measCols = {
        "label": "TEXT DEFAULT 'Standard'",
        "hip_round": "TEXT", "seat_round": "TEXT", "bicep_round": "TEXT", "cuff_round": "TEXT",
        "neck": "TEXT", "cuff_height": "TEXT", "fit_style": "TEXT", "front_patti_style": "TEXT",
        "shirt_bottom_type": "TEXT", "sleeve_type": "TEXT",
        "waist": "TEXT", "seat": "TEXT", "thigh": "TEXT", "knee_loose": "TEXT",
        "bottom_loose": "TEXT", "zip_length": "TEXT", "in_seam": "TEXT",
        "pant_type": "TEXT", "pocket_type": "TEXT", "back_pocket": "TEXT",
        "updated_at": "DATETIME"
    };
    await migrateTable("measurements", measCols);

    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_meas_cust_type_label ON measurements(customer_id, type, label)`);

    const itemCols = { "item_type": "TEXT", "quantity": "INTEGER", "price": "REAL", "amount": "REAL" };
    await migrateTable("order_items", itemCols);
}

async function migrateTable(tableName, colMap) {
    const cols = await all(`PRAGMA table_info(${tableName})`);
    const existing = cols.map(c => c.name.toLowerCase().trim());
    for (const col of Object.keys(colMap)) {
        const colName = col.toLowerCase().trim();
        if (!existing.includes(colName)) {
            try {
                await run(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colMap[col]}`);
            } catch (e) {
                console.error(`Migration Failed for ${tableName}.${colName}:`, e.message);
            }
        }
    }
}


// --- EXPORTS ---
module.exports = {
    initialize,
    get: (sql, params, cb) => db.get(sql, params, cb),
    all: (sql, params, cb) => db.all(sql, params, cb),
    run: (sql, params, cb) => db.run(sql, params, function(err) { if (cb) cb.call(this, err); }),
    exec: (sql, cb) => db.exec(sql, cb),
    close: () => new Promise((resolve, reject) => {
        db.close((err) => err ? reject(err) : resolve());
    })
};

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Console logs enabled for debugging

// --- IPC DATABASE SHIM ---
const db = {
    get: (sql, params = [], cb) => {
        if (typeof params === 'function') { cb = params; params = []; }
        const p = ipcRenderer.invoke('db-get', sql, params);
        if (cb) p.then(r => cb(null, r)).catch(e => cb(e));
        return p;
    },
    all: (sql, params = [], cb) => {
        if (typeof params === 'function') { cb = params; params = []; }
        const p = ipcRenderer.invoke('db-all', sql, params);
        if (cb) p.then(r => cb(null, r)).catch(e => cb(e));
        return p;
    },
    run: (sql, params = [], cb) => {
        if (typeof params === 'function') { cb = params; params = []; }
        const p = ipcRenderer.invoke('db-run', sql, params);
        if (cb) p.then(r => cb.call(r, null)).catch(e => cb(e));
        return p;
    },
    exec: (sql, cb) => {
        const p = ipcRenderer.invoke('db-exec', sql);
        if (cb) p.then(r => cb(null)).catch(e => cb(e));
        return p;
    },
    serialize: (cb) => cb()
};

// --- APP STATE ---
let orderItems = [];
let editingOrderId = null;
let revenueChart = null;
let pendingPrintData = null; // Store data for the success modal to print


// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
    console.log("DOM Loaded - Initializing App");

    // 1. SECURITY CHECK
    try {
        const status = await ipcRenderer.invoke('get-activation-status');
        if (status && !status.activated) {
            document.getElementById('activationOverlay').classList.remove('hidden');
            document.getElementById('requestCodeDisplay').innerText = status.requestId || "ERROR";
            return; // Stop initialization
        }
    } catch (e) {
        console.error("Activation check failed:", e);
        // We continue anyway so the app doesn't stay frozen
    }

    try {
        initTabs();
        initDates();
        initMeasurements();
        initAutoInseam();
        document.getElementById('measurementType').value = 'shirt';
        toggleMeasurementType();
        showTab('dashboard');
        console.log("App Initialization Complete");
    } catch (e) {
        console.error("Initialization Error:", e);
    }
});

window.submitActivation = async function () {
    const key = document.getElementById('activationKeyInput').value;
    if (!key) return showStatus("Please enter a key", "❌");

    showStatus("Verifying license...", "⏳");
    const result = await ipcRenderer.invoke('activate-app', key);

    if (result.success) {
        showStatus("Activation Successful!", "✅");
        setTimeout(() => {
            window.location.reload(); // Reload to start the app
        }, 1500);
    } else {
        showStatus("Invalid Activation Key!", "❌");
    }
};

function initMeasurements() {
    // Real-time validation listeners
    // Use the measurements container to narrow down to measurement fields only
    const inputs = document.querySelectorAll(".measurements input, .measurements select");

    inputs.forEach(el => {
        el.addEventListener("input", () => {
            highlightMissing();
            updateStatus();
        });
        // Also listen for change on selects
        el.addEventListener("change", () => {
            highlightMissing();
            updateStatus();
        });
    });

    // Phone search listener
    const phoneInput = document.getElementById('phone');
    if (phoneInput) {
        phoneInput.addEventListener('blur', () => {
            const phone = phoneInput.value.trim();
            if (phone) searchData(phone);
        });
    }
}

function initAutoInseam() {
    console.log("Reinforcing Auto-Inseam Calculation...");

    // Use a global listener on the document for any input change
    // This handles both new order and edit modal consistently
    document.addEventListener('input', (e) => handleInseam(e));
    document.addEventListener('change', (e) => handleInseam(e));

    function handleInseam(e) {
        const target = e.target;
        if (!target) return;

        // Check if the input is one of our height fields
        if (target.id === 'height' || target.id === 'edit-height') {
            const hId = target.id;
            const iId = hId === 'height' ? 'in_seam' : 'edit-in_seam';
            const iEl = document.getElementById(iId);

            if (iEl) {
                const val = target.value.trim();
                if (!val) {
                    iEl.value = "";
                } else {
                    const h = parseFloat(val);
                    if (!isNaN(h) && h > 0) {
                        let inseam = Math.round(h * 0.45);
                        if (inseam < 26) inseam = 26;
                        if (inseam > 36) inseam = 36;
                        iEl.value = inseam;
                        // Manually trigger input event on inseam so other logic knows it changed
                        iEl.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
            }
        }
    }

    console.log("Global Auto-Inseam Listener Attached.");
}

// --- MEASUREMENT LOGIC (Dual-Table System) ---

function loadMeasurements(customerId) {
    let shirt = undefined;
    let pant = undefined;

    const done = () => {
        // Only update UI once both calls have responded
        if (shirt !== undefined && pant !== undefined) {
            clearMeasurementUI();
            if (shirt) fillFields(shirt);
            if (pant) fillFields(pant);
            highlightMissing();
            updateStatus();
            showStatus("Customer Measurements Loaded", "📏");
        }
    };

    db.get(`SELECT * FROM shirt_measurements WHERE customer_id = ?`, [customerId], (err, s) => {
        shirt = s || null;
        done();
    });

    db.get(`SELECT * FROM pant_measurements WHERE customer_id = ?`, [customerId], (err, p) => {
        pant = p || null;
        done();
    });
}

function fillFields(data) {
    if (!data) return;
    Object.keys(data).forEach(key => {
        const el = document.getElementById(key);
        if (el) el.value = data[key] || "";
    });
}

function clearMeasurementUI() {
    const fields = document.querySelectorAll(".measurements input, .measurements select, .measurements textarea");
    fields.forEach(el => {
        el.value = "";
        el.classList.remove("missing");
    });
    // Reset to Shirt section
    document.getElementById("measurementType").value = "shirt";
    toggleMeasurementType();
}

function toggleMeasurementType() {
    const type = document.getElementById("measurementType").value;
    const shirt = document.getElementById("shirtSection");
    const pant = document.getElementById("pantSection");

    if (shirt) shirt.style.display = type === "shirt" ? "block" : "none";
    if (pant) pant.style.display = type === "pant" ? "block" : "none";

    updateStatus();
    highlightMissing();
}

function highlightMissing() {
    // Red marks removed as per user request
}

function updateStatus() {
    // Status text removed as per user request
}

function collectMeasurements() {
    const data = {};
    const fields = document.querySelectorAll(".measurements input, .measurements select, .measurements textarea");
    fields.forEach(el => {
        if (el.id) data[el.id] = el.value;
    });
    return data;
}

async function saveMeasurementsAtomic(customerId) {
    const m = collectMeasurements();

    // SHIRT UPSERT - Covers all new dynamic fields
    const shirtSql = `
        INSERT INTO shirt_measurements (
            customer_id, length, chest, chest_correct, hip, hip_round, seat, seat_round, shoulder, 
            sleeve_height, bicep_round, cuff_round_finish, neck, cuff_height, 
            fit_style, front_patti_style, apple_cut
        )
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(customer_id) DO UPDATE SET
            length=excluded.length, chest=excluded.chest, chest_correct=excluded.chest_correct, 
            hip=excluded.hip, hip_round=excluded.hip_round, seat=excluded.seat, seat_round=excluded.seat_round,
            shoulder=excluded.shoulder, sleeve_height=excluded.sleeve_height, bicep_round=excluded.bicep_round,
            cuff_round_finish=excluded.cuff_round_finish, neck=excluded.neck, cuff_height=excluded.cuff_height,
            fit_style=excluded.fit_style, front_patti_style=excluded.front_patti_style, 
            apple_cut=excluded.apple_cut, updated_at=CURRENT_TIMESTAMP
    `;
    const shirtParams = [
        customerId, m.length, m.chest, m.chest_correct, m.hip, m.hip_round, m.seat, m.seat_round, m.shoulder,
        m.sleeve_height, m.bicep_round, m.cuff_round_finish, m.neck, m.cuff_height,
        m.fit_style, m.front_patti_style, m.apple_cut
    ];

    // PANT UPSERT - Covers all new dynamic fields
    const pantSql = `
        INSERT INTO pant_measurements (
            customer_id, height, waist, seat_pant, thigh, knee_loose, bottom_loose, 
            zip_length, in_seam, pant_type, pocket_type, back_pocket, 
            mobile_pocket, watch_pocket
        )
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(customer_id) DO UPDATE SET
            height=excluded.height, waist=excluded.waist, seat_pant=excluded.seat_pant, 
            thigh=excluded.thigh, knee_loose=excluded.knee_loose, bottom_loose=excluded.bottom_loose,
            zip_length=excluded.zip_length, in_seam=excluded.in_seam,
            pant_type=excluded.pant_type, pocket_type=excluded.pocket_type,
            back_pocket=excluded.back_pocket, mobile_pocket=excluded.mobile_pocket,
            watch_pocket=excluded.watch_pocket, updated_at=CURRENT_TIMESTAMP
    `;
    const pantParams = [
        customerId, m.height, m.waist, m.seat_pant, m.thigh, m.knee_loose, m.bottom_loose,
        m.zip_length, m.in_seam, m.pant_type, m.pocket_type, m.back_pocket,
        m.mobile_pocket, m.watch_pocket
    ];

    await db.run(shirtSql, shirtParams);
    await db.run(pantSql, pantParams);
}

function initTabs() {
    console.log("Tabs initialized via HTML onclick");
}

let currentCalendarDate = new Date();

function showTab(tabId) {
    try {
        console.log("Switching to tab:", tabId);
        // showStatus("Switching to " + tabId, "ℹ️"); // Temporary debug

        // Nav active state
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        const navItem = document.querySelector(`[data-tab="${tabId}"]`);
        if (navItem) navItem.classList.add('active');

        // Tab visibility
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        const tabContent = document.getElementById(`tab-${tabId}`);
        if (tabContent) tabContent.classList.add('active');

        // Load data for specific tabs
        if (tabId === 'dashboard') {
            loadDashboardStats();
            loadTodayDeliveries();
            loadSearchDeliveries();
        }
        if (tabId === 'orders') loadHistory();
        if (tabId === 'customers') loadCustomers();
        if (tabId === 'settings') loadBackupList();
        if (tabId === 'delivery-calendar') renderCalendar();
    } catch (e) {
        console.error("Tab switch failed:", e);
    }
}

window.changeMonth = function(offset) {
    currentCalendarDate.setMonth(currentCalendarDate.getMonth() + offset);
    renderCalendar();
};

async function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    const title = document.getElementById('currentMonthYear');
    if (!grid || !title) return;

    grid.innerHTML = '';
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    title.innerText = `${monthNames[month]} ${year}`;

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // Empty cells for padding
    for (let i = 0; i < firstDay; i++) {
        const div = document.createElement('div');
        div.style.height = '100px';
        grid.appendChild(div);
    }

    // Days with orders
    const startOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const endOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-${daysInMonth}`;

    const sql = `SELECT delivery_date, COUNT(*) as count FROM orders WHERE delivery_date BETWEEN ? AND ? GROUP BY delivery_date`;
    db.all(sql, [startOfMonth, endOfMonth], (err, rows) => {
        const orderCounts = {};
        if (!err && rows) rows.forEach(r => orderCounts[r.delivery_date] = r.count);

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const isToday = new Date().toISOString().split('T')[0] === dateStr;
            const count = orderCounts[dateStr] || 0;

            const dayDiv = document.createElement('div');
            dayDiv.className = 'calendar-day';
            dayDiv.style.cssText = `
                height: 100px;
                border: 1px solid #f1f5f9;
                border-radius: 8px;
                padding: 8px;
                position: relative;
                cursor: pointer;
                background: ${isToday ? '#f0f9ff' : '#fff'};
                border-color: ${isToday ? '#0ea5e9' : '#f1f5f9'};
            `;
            dayDiv.onclick = () => {
                document.getElementById('deliveryFilter').value = dateStr;
                showTab('dashboard');
                loadSearchDeliveries();
            };

            dayDiv.innerHTML = `
                <div style="font-weight: 800; font-size: 14px; color: ${isToday ? '#0ea5e9' : '#1e293b'};">${d}</div>
                ${count > 0 ? `
                    <div style="margin-top: 10px; background: #6366f1; color: white; font-size: 10px; padding: 4px 8px; border-radius: 99px; display: inline-block; font-weight: 700;">
                        ${count} Delivery${count > 1 ? 's' : ''}
                    </div>
                ` : ''}
            `;
            grid.appendChild(dayDiv);
        }
    });
}

function initDates() {
    const today = new Date().toLocaleDateString('en-CA');
    document.getElementById('givenDate').value = today;
    document.getElementById('deliveryDate').value = today;
    // Removed default deliveryFilter value so search starts empty
}

// --- DASHBOARD ---
async function loadDashboardStats() {
    const today = new Date().toISOString().split('T')[0];

    db.get("SELECT SUM(total) as total FROM orders", (err, row) => {
        if (!err) document.getElementById('stat-total-revenue').innerText = "₹ " + (row.total || 0).toLocaleString();
    });

    db.get("SELECT COUNT(*) as count FROM orders", (err, row) => {
        if (!err) document.getElementById('stat-total-orders').innerText = row.count;
    });

    db.get("SELECT COUNT(*) as count FROM orders WHERE status = 'DELIVERED'", (err, row) => {
        if (!err) document.getElementById('stat-total-delivered').innerText = row.count;
    });

    db.get("SELECT COUNT(*) as count FROM orders WHERE delivery_date = ?", [today], (err, row) => {
        if (!err) document.getElementById('stat-today-deliveries').innerText = row.count;
    });

    db.get("SELECT COUNT(*) as count FROM orders WHERE delivery_date < ? AND status != 'DELIVERED'", [today], (err, row) => {
        if (!err) document.getElementById('stat-overdue-orders').innerText = row.count;
    });

    loadOverdueAlerts(today);
    loadOverdueDeliveries(today);

    // Chart Data (Last 7 Days)
    db.all(`
        SELECT delivery_date as date, SUM(total) as daily_total 
        FROM orders 
        WHERE delivery_date >= date('now', '-7 days')
        GROUP BY delivery_date
        ORDER BY delivery_date ASC
    `, (err, rows) => {
        if (!err) updateRevenueChart(rows);
    });

    // Status Chart
    db.all(`SELECT status, COUNT(*) as count FROM orders GROUP BY status`, [], (err, rows) => {
        if (!err) updateStatusChart(rows);
    });
}

function loadOverdueDeliveries(today) {
    const list = document.getElementById('overdueDeliveryList');
    if (!list) return;

    db.all("SELECT o.*, c.name FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.delivery_date < ? AND (o.status IS NULL OR o.status != 'DELIVERED') ORDER BY o.delivery_date ASC", [today], async (err, rows) => {
        if (err || !rows || rows.length === 0) {
            list.innerHTML = `<div style="text-align: center; padding: 40px; color: #94a3b8;">
                <span class="material-symbols-outlined" style="font-size: 32px; opacity: 0.3;">verified</span>
                <p style="font-size: 12px; margin-top: 8px;">No overdue orders!</p>
            </div>`;
            return;
        }
        await renderDeliveryList(rows, list);
    });
}

let statusChart = null;
function updateStatusChart(data) {
    const canvas = document.getElementById('statusChart');
    if (!canvas || typeof Chart === 'undefined') return;
    const ctx = canvas.getContext('2d');

    const counts = { 'PENDING': 0, 'DELIVERED': 0 };
    data.forEach(r => {
        if (r.status === 'PENDING' || r.status === 'DELIVERED') {
            counts[r.status] = r.count;
        }
    });

    if (statusChart) statusChart.destroy();

    statusChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Pending', 'Delivered'],
            datasets: [{
                data: [counts['PENDING'], counts['DELIVERED']],
                backgroundColor: ['#ef4444', '#10b981'],
                borderWidth: 0,
                hoverOffset: 10
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        font: { family: "'Inter', sans-serif", weight: '700', size: 12 },
                        padding: 20
                    }
                }
            },
            cutout: '70%'
        }
    });
}

function updateRevenueChart(data) {
    const canvas = document.getElementById('revenueChart');
    if (!canvas || typeof Chart === 'undefined') return;
    const ctx = canvas.getContext('2d');
    const labels = data.map(d => {
        const date = new Date(d.date);
        return date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' });
    });
    const totals = data.map(d => d.daily_total);

    // Create a beautiful, soft fading gradient for the area fill
    const fillGradient = ctx.createLinearGradient(0, 0, 0, 350);
    fillGradient.addColorStop(0, 'rgba(139, 92, 246, 0.4)');  // Vibrant Purple (Semi-transparent)
    fillGradient.addColorStop(1, 'rgba(139, 92, 246, 0.0)');  // Fades to completely transparent

    if (revenueChart) revenueChart.destroy();

    revenueChart = new Chart(ctx, {
        type: 'line', // Smooth curved line chart
        data: {
            labels: labels,
            datasets: [{
                label: 'Revenue',
                data: totals,
                borderColor: '#8b5cf6', // Solid Vibrant Purple line
                borderWidth: 4,
                backgroundColor: fillGradient, // Soft gradient underneath
                fill: true,
                tension: 0.4, // Makes the line smoothly curved
                pointBackgroundColor: '#ffffff',
                pointBorderColor: '#8b5cf6',
                pointBorderWidth: 3,
                pointRadius: 0, // Hide points by default for a cleaner look
                pointHoverRadius: 7, // Show large glowing point on hover
                pointHoverBackgroundColor: '#8b5cf6',
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 3,
                hitRadius: 30 // Larger invisible hover area for easier interaction
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: {
                duration: 2000,
                easing: 'easeOutQuart'
            },
            interaction: {
                intersect: false,
                mode: 'index',
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.9)', // Sleek dark tooltip
                    titleFont: { size: 13, weight: '600', family: "'Inter', sans-serif" },
                    bodyFont: { size: 15, weight: '800', family: "'Inter', sans-serif" },
                    padding: 14,
                    cornerRadius: 10,
                    displayColors: false,
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    callbacks: {
                        label: function (context) {
                            return `₹ ${context.parsed.y.toLocaleString('en-IN')}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(226, 232, 240, 0.5)', drawBorder: false }, // Very subtle horizontal lines
                    ticks: {
                        font: { size: 11, weight: '600', family: "'Inter', sans-serif" },
                        color: '#94a3b8',
                        padding: 12,
                        callback: function (value) { return '₹' + value; }
                    }
                },
                x: {
                    grid: { display: false, drawBorder: false }, // Completely hide vertical grid
                    ticks: {
                        font: { size: 12, weight: '600', family: "'Inter', sans-serif" },
                        color: '#94a3b8',
                        padding: 8
                    }
                }
            }
        }
    });
}

function loadOverdueAlerts(today) {
    const alertList = document.getElementById('overdueAlerts');
    if (!alertList) return;

    db.all(`
        SELECT o.*, c.name FROM orders o 
        JOIN customers c ON o.customer_id = c.id 
        WHERE o.delivery_date < ? AND (o.status IS NULL OR o.status != 'DELIVERED')
        ORDER BY o.delivery_date ASC LIMIT 5
    `, [today], (err, rows) => {
        if (!err && rows && rows.length > 0) {
            const todayDate = new Date(today);
            alertList.innerHTML = `
                <div style="background: #fef2f2; border: 1px solid #000; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span class="material-symbols-outlined" style="color: #000; font-size: 24px;">priority_high</span>
                            <h3 style="margin: 0; font-size: 16px; font-weight: 800; color: #000; text-transform: uppercase;">⚠️ Attention Required</h3>
                        </div>
                        <button class="secondary" onclick="viewAllOverdue()" style="height: 32px; font-size: 11px; font-weight: 800; background: #fff; border: 1px solid #000; padding: 0 12px; border-radius: 6px;">VIEW ALL</button>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        ${rows.map(r => {
                const delDate = new Date(r.delivery_date);
                const daysDiff = Math.ceil((todayDate - delDate) / (1000 * 60 * 60 * 24));

                // URGENCY INDICATOR COLORS
                let urgencyColor = '#fbbf24'; // Yellow (1-2 days)
                if (daysDiff > 2) urgencyColor = '#f97316'; // Orange (3-7 days)
                if (daysDiff > 7) urgencyColor = '#ef4444'; // Red (7+ days)

                return `
                                <div class="card fade-in" style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border: 1px solid #000; background: #fff;">
                                    <div style="display: flex; align-items: center; gap: 15px;">
                                        <div style="background: ${urgencyColor}; color: #fff; width: 45px; height: 45px; border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; font-weight: 900; font-size: 10px; border: 1.5px solid #000;">
                                            <span style="font-size: 16px;">${daysDiff}</span>
                                            <span>DAYS</span>
                                        </div>
                                        <div>
                                            <div style="font-weight: 800; font-size: 14px; color: #000;">${r.name}</div>
                                            <div style="font-size: 11px; color: #4b5563; font-weight: 700;">Bill #${r.bill_number} • Due: ${r.delivery_date}</div>
                                        </div>
                                    </div>
                                    <button class="primary" style="background: #000; border: none; height: 36px; padding: 0 16px; font-weight: 800; border-radius: 8px; font-size: 11px;" onclick="openDeliveryModal(${r.id})">SUBMIT</button>
                                </div>
                            `;
            }).join('')}
                    </div>
                </div>
            `;
        } else {
            alertList.innerHTML = '';
        }
    });
}

function viewAllOverdue() {
    showTab('orders');
    const toggle = document.getElementById('overdueFilterToggle');
    if (toggle) {
        toggle.checked = true;
        loadHistory();
    }
}

function setFilterDate(type) {
    const filter = document.getElementById('deliveryFilter');
    if (type === 'today') {
        filter.value = new Date().toISOString().split('T')[0];
    }
    loadDeliveries();
}

let isTodayLoading = false;
function loadTodayDeliveries() {
    if (isTodayLoading) return;
    isTodayLoading = true;
    const today = new Date().toLocaleDateString('en-CA');
    const list = document.getElementById('todayDeliveryList');
    if (!list) { isTodayLoading = false; return; }

    // Fetch BOTH delivered and pending to calculate progress
    db.all("SELECT status FROM orders WHERE delivery_date = ?", [today], (err, allToday) => {
        const total = allToday ? allToday.length : 0;
        const delivered = allToday ? allToday.filter(o => o.status === 'DELIVERED').length : 0;
        const percent = total > 0 ? Math.round((delivered / total) * 100) : 0;

        db.all("SELECT o.*, c.name FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.delivery_date = ? AND (o.status IS NULL OR o.status != 'DELIVERED') ORDER BY o.balance DESC", [today], async (err, rows) => {
            if (err || !rows || rows.length === 0) {
                list.innerHTML = `
                    <div style="margin-bottom: 15px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                            <span style="font-size: 11px; font-weight: 800; color: #64748b;">DAILY PROGRESS</span>
                            <span style="font-size: 11px; font-weight: 900; color: #10b981;">${percent}%</span>
                        </div>
                        <div style="height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden; border: 1px solid #000;">
                            <div style="width: ${percent}%; height: 100%; background: #10b981; transition: width 0.5s ease;"></div>
                        </div>
                    </div>
                    <div style="text-align: center; padding: 30px; color: #94a3b8;">
                        <span class="material-symbols-outlined" style="font-size: 40px; opacity: 0.3;">task_alt</span>
                        <p style="font-size: 13px; margin-top: 10px;">No pending deliveries for today.</p>
                    </div>`;
                isTodayLoading = false;
                return;
            }

            const orderIds = rows.map(r => r.id);
            db.all(`SELECT item_type, SUM(quantity) as total_qty FROM order_items WHERE order_id IN (${orderIds.join(',')}) GROUP BY item_type`, async (iErr, itemStats) => {
                let summaryHtml = `
                    <div style="margin-bottom: 15px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                            <span style="font-size: 11px; font-weight: 800; color: #64748b;">DAILY PROGRESS (${delivered}/${total})</span>
                            <span style="font-size: 11px; font-weight: 900; color: #10b981;">${percent}%</span>
                        </div>
                        <div style="height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden; border: 1px solid #000;">
                            <div style="width: ${percent}%; height: 100%; background: #10b981; transition: width 0.5s ease;"></div>
                        </div>
                    </div>`;

                if (!iErr && itemStats.length > 0) {
                    summaryHtml += `
                        <div style="background: #f8fafc; border: 1px solid #000; border-radius: 8px; padding: 8px 12px; margin-bottom: 15px; display: flex; gap: 15px; align-items: center; overflow-x: auto;">
                            <span style="font-size: 11px; font-weight: 900; color: #000; white-space: nowrap; text-transform: uppercase;">📊 Workload:</span>
                            ${itemStats.map(s => `<span style="font-size: 12px; font-weight: 800; color: #475569; white-space: nowrap;">${s.total_qty}x ${s.item_type}</span>`).join('<span style="color: #cbd5e1;">|</span>')}
                        </div>`;
                }
                list.innerHTML = summaryHtml;
                await renderDeliveryList(rows, list, true);
                isTodayLoading = false;
            });
        });
    });
}

let isSearchLoading = false;
function loadSearchDeliveries() {
    if (isSearchLoading) return;
    isSearchLoading = true;
    const filter = document.getElementById('deliveryFilter');
    const date = filter ? filter.value : null;
    const list = document.getElementById('searchDeliveryList');
    if (!list) { isSearchLoading = false; return; }

    if (!date) {
        list.innerHTML = `<div style="text-align: center; padding: 30px; color: #94a3b8;"><p>Select a date to search</p></div>`;
        isSearchLoading = false;
        return;
    }

    db.all("SELECT o.*, c.name FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.delivery_date = ?", [date], async (err, rows) => {
        if (err || !rows || rows.length === 0) {
            list.innerHTML = `
                <div style="text-align: center; padding: 30px; color: #94a3b8;">
                    <span class="material-symbols-outlined" style="font-size: 40px; opacity: 0.3;">search_off</span>
                    <p style="font-size: 13px; margin-top: 10px;">No deliveries found for this date.</p>
                </div>`;
            isSearchLoading = false;
            return;
        }

        const totalBalance = rows.reduce((sum, r) => sum + (r.balance || 0), 0);

        // SEARCH WORKLOAD SUMMARY
        const orderIds = rows.map(r => r.id);
        db.all(`SELECT item_type, SUM(quantity) as total_qty FROM order_items WHERE order_id IN (${orderIds.join(',')}) GROUP BY item_type`, async (iErr, itemStats) => {
            let summaryHtml = `
                <div style="background: #000; color: #fff; border-radius: 8px; padding: 10px 15px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-size: 11px; font-weight: 800; color: #94a3b8; text-transform: uppercase;">Total Collection</div>
                    <div style="font-size: 18px; font-weight: 900; color: #fff;">₹ ${totalBalance}</div>
                </div>`;

            if (!iErr && itemStats.length > 0) {
                summaryHtml += `
                    <div style="background: #f8fafc; border: 1px solid #000; border-radius: 8px; padding: 8px 12px; margin-bottom: 15px; display: flex; gap: 15px; align-items: center; overflow-x: auto;">
                        <span style="font-size: 11px; font-weight: 900; color: #000; white-space: nowrap; text-transform: uppercase;">🔍 Search Load:</span>
                        ${itemStats.map(s => `<span style="font-size: 12px; font-weight: 800; color: #475569; white-space: nowrap;">${s.total_qty}x ${s.item_type}</span>`).join('<span style="color: #cbd5e1;">|</span>')}
                    </div>`;
            }
            list.innerHTML = summaryHtml;
            await renderDeliveryList(rows, list, true); // true = append after summary
            isSearchLoading = false;
        });
    });
}

async function renderDeliveryList(rows, container, append = false) {
    if (!append) container.innerHTML = '';

    for (const r of rows) {
        const items = await new Promise((resolve) => {
            db.all("SELECT item_type, quantity FROM order_items WHERE order_id = ?", [r.id], (err, res) => resolve(res || []));
        });

        const itemSummary = items.map(i => `${i.quantity}x ${i.item_type}`).join(', ');
        const card = document.createElement('div');
        card.className = 'card fade-in';
        card.style = 'padding: 4px 10px; border: 1px solid #000; transition: all 0.2s; cursor: pointer; background: #fff; border-radius: 6px; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between; gap: 10px;';
        card.onclick = () => openDeliveryModal(r.id);
        card.innerHTML = `
            <div style="flex-grow: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <div style="font-weight: 800; font-size: 11px; color: #000; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${r.name}</div>
                    <div style="font-size: 8px; font-weight: 900; background: #000; color: #fff; padding: 1px 4px; border-radius: 3px;">#${r.bill_number}</div>
                    ${r.status === 'DELIVERED' ? '<span style="font-size: 8px; font-weight: 900; background: #10b981; color: #fff; padding: 1px 4px; border-radius: 3px;">DELIVERED</span>' : ''}
                </div>
                <div style="font-size: 10px; font-weight: 600; color: #64748b; display: flex; align-items: center; gap: 4px;">
                    <span class="material-symbols-outlined" style="font-size: 12px;">inventory_2</span> ${itemSummary || 'No items'}
                </div>
            </div>
            <div style="display: flex; align-items: center; gap: 10px; flex-shrink: 0;">
                <div style="font-size: 12px; font-weight: 900; color: ${r.balance > 0 ? '#ef4444' : '#10b981'};">₹${r.balance}</div>
                <button class="primary" style="height: 20px; padding: 0 8px; font-size: 8px; background: #000; border-radius: 3px; font-weight: 800;">${r.status === 'DELIVERED' ? 'VIEW' : 'DONE'}</button>
            </div>
        `;
        container.appendChild(card);
    }
}

// --- NEW ORDER LOGIC ---
function addItem() {
    const type = document.getElementById('itemType').value;
    const qty = parseInt(document.getElementById('qty').value) || 1;
    const price = parseFloat(document.getElementById('price').value) || 0;

    if (isNaN(qty) || isNaN(price) || price <= 0) return;

    orderItems.push({ type, qty, price, total: qty * price });
    renderOrderItems();

    // Reset inputs but keep focus
    document.getElementById('qty').value = 1;
    document.getElementById('price').value = 0;
    document.getElementById('itemType').focus();
}

function renderOrderItems() {
    const tbody = document.getElementById('orderItemsBody');
    tbody.innerHTML = orderItems.map((item, i) => `
        <tr>
            <td>${item.type}</td>
            <td>${item.qty}</td>
            <td>₹ ${item.price}</td>
            <td>₹ ${item.total}</td>
            <td><button class="secondary" style="height: 28px; padding: 0 10px;" onclick="removeItem(${i})">Remove</button></td>
        </tr>
    `).join('');
    calculateBalance();
}

function removeItem(index) {
    orderItems.splice(index, 1);
    renderOrderItems();
}

function calculateBalance() {
    const total = orderItems.reduce((sum, item) => sum + item.total, 0);
    const advance = parseFloat(document.getElementById('advance').value) || 0;
    const balance = total - advance;

    const label = document.getElementById('balanceLabel');
    label.innerText = `₹ ${balance}`;
    label.style.color = balance > 0 ? 'var(--danger)' : 'var(--success)';
}

// --- SAVING (ATOMIC) ---
async function saveOrderFinal() {
    const billNumber = document.getElementById('billNumber').value.trim();
    const phone = document.getElementById('phone').value.trim();
    const name = document.getElementById('name').value.trim();

    if (!billNumber) return showStatus("Bill number is required!", "❌");
    if (!name) return showStatus("Customer Name is required!", "❌");
    if (!phone) return showStatus("Phone number is required!", "❌");

    // Strict 10-digit phone number validation
    const phoneRegex = /^\d{10}$/;
    if (!phoneRegex.test(phone)) {
        return showStatus("Phone number must be exactly 10 digits (no +91)", "❌");
    }

    if (orderItems.length === 0) return showStatus("Add at least one item!", "❌");

    try {
        // 1. Strict Uniqueness Check for Bill Number
        const row = await db.get("SELECT id FROM orders WHERE bill_number = ? AND id != ?", [billNumber, editingOrderId || 0]);
        if (row) {
            const billEl = document.getElementById('billNumber');
            if (billEl) {
                billEl.style.borderColor = '#ef4444';
                billEl.style.boxShadow = '0 0 0 4px rgba(239, 68, 68, 0.2)';
                billEl.focus();
                setTimeout(() => {
                    billEl.style.borderColor = '';
                    billEl.style.boxShadow = '';
                }, 3000);
            }
            return showStatus("DUPLICATE BILL! This Bill Number already exists in the system.", "❌");
        }

        // 2. Proceed with saving
        showStatus(editingOrderId ? "Updating order..." : "Saving order...", "⏳");

        const { orderId, customerId } = await saveDataAtomic();

        // 3. Save Measurements
        try {
            await saveMeasurementsAtomic(customerId);
        } catch (mErr) {
            console.error("Measurement save error:", mErr);
            showStatus("Order saved, but measurements failed!", "⚠️");
        }

        // Set data for the success modal print button
        pendingPrintData = {
            info: {
                bill_number: document.getElementById("billNumber").value,
                name: document.getElementById("name").value,
                phone: document.getElementById("phone").value,
                order_date: document.getElementById("givenDate").value,
                delivery_date: document.getElementById("deliveryDate").value,
                shirt_notes: document.getElementById("shirt_notes")?.value || "",
                pant_notes: document.getElementById("pant_notes")?.value || ""
            },
            data: collectMeasurements()
        };

        // Update Title for Edit/New
        document.getElementById('successTitle').innerText = editingOrderId ? "Order Updated!" : "Order Saved!";
        document.getElementById('successMsg').innerText = `Order #${document.getElementById('billNumber').value} has been ${editingOrderId ? 'updated' : 'added'} successfully.`;

        // Show Success Modal
        const measurements = collectMeasurements();
        
        // Detection Logic: Check if items are in the order list OR if measurements are filled
        const hasShirtItem = orderItems.some(i => i.type.toLowerCase().includes('shirt'));
        const hasPantItem = orderItems.some(i => i.type.toLowerCase().includes('pant'));
        
        const hasShirtMeas = !!(measurements.length || measurements.chest || measurements.shoulder);
        const hasPantMeas = !!(measurements.waist || measurements.height || measurements.thigh);

        const showShirt = hasShirtItem || hasShirtMeas;
        const showPant = hasPantItem || hasPantMeas;

        document.getElementById('success-print-shirt').style.display = showShirt ? 'flex' : 'none';
        document.getElementById('success-print-pant').style.display = showPant ? 'flex' : 'none';
        document.getElementById('success-print-both').style.display = (showShirt && showPant) ? 'flex' : 'none';
        
        document.getElementById('successModal').classList.remove('hidden');
        backupDB();
        loadDashboardStats();
        loadHistory();

    } catch (err) {
        console.error("CRITICAL SAVE ERROR:", err);
        if (err.message && err.message.includes("UNIQUE")) {
            showStatus("Database constraint error! (Duplicate phone or bill)", "❌");
        } else {
            showStatus("Failed to save order: " + err.message, "❌");
        }
    }
}

function confirmSuccessPrint() {
    if (pendingPrintData) {
        generateMeasurementSlip(pendingPrintData.info, pendingPrintData.data);
        pendingPrintData = null;
    } else {
        printMeasurements();
    }
    window.closeSuccessModal();
}

window.closeSuccessModal = function() {
    document.getElementById('successModal').classList.add('hidden');
    pendingPrintData = null; 
    resetForm();
    loadDashboardStats();
};

async function saveDataAtomic() {
    const name = document.getElementById('name').value.trim();
    const phone = document.getElementById('phone').value.trim();
    const bill = document.getElementById('billNumber').value.trim();
    const gDate = document.getElementById('givenDate').value;
    const dDate = document.getElementById('deliveryDate').value;
    const advance = parseFloat(document.getElementById('advance').value) || 0;
    const total = orderItems.reduce((sum, item) => sum + item.total, 0);
    const notes = document.getElementById('notes').value.trim();
    const shirtNotes = document.getElementById('shirt_notes').value.trim();
    const pantNotes = document.getElementById('pant_notes').value.trim();
    const now = new Date().toISOString();

    try {
        await db.run("BEGIN TRANSACTION");

        // 1. Customer UPSERT (Idempotent)
        await db.run("INSERT INTO customers (name, phone, created_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET name=excluded.name", [name, phone, now]);

        const customer = await db.get("SELECT id FROM customers WHERE phone = ?", [phone]);
        if (!customer) throw new Error("Customer record could not be created or retrieved.");
        const cid = customer.id;

        let oid = editingOrderId;
        if (editingOrderId) {
            // UPDATE EXISTING ORDER
            await db.run(`UPDATE orders SET bill_number=?, total=?, advance=?, balance=?, given_date=?, delivery_date=?, customer_id=?, notes=?, shirt_notes=?, pant_notes=? WHERE id=?`,
                [bill, total, advance, total - advance, gDate, dDate, cid, notes, shirtNotes, pantNotes, editingOrderId]);

            // Clear old items for re-insertion
            await db.run("DELETE FROM order_items WHERE order_id=?", [editingOrderId]);
        } else {
            // NEW ORDER INSERT
            const res = await db.run("INSERT INTO orders (customer_id, bill_number, total, advance, balance, given_date, delivery_date, notes, shirt_notes, pant_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [cid, bill, total, advance, total - advance, gDate, dDate, notes, shirtNotes, pantNotes]);
            oid = res.lastID;
        }

        // 2. Insert Order Items
        for (const item of orderItems) {
            await db.run("INSERT INTO order_items (order_id, item_type, quantity, price, amount) VALUES (?, ?, ?, ?, ?)",
                [oid, item.type, item.qty, item.price, item.total]);
        }

        await db.run("COMMIT");
        return { orderId: oid, customerId: cid };

    } catch (err) {
        console.error("Atomic Save Transactional Error:", err);
        await db.run("ROLLBACK").catch(() => { });
        throw err;
    }
}

function resetForm() {
    document.getElementById('billNumber').value = '';
    document.getElementById('phone').value = '';
    document.getElementById('name').value = '';
    document.getElementById('advance').value = 0;
    orderItems = [];
    editingOrderId = null; // Clear edit mode
    renderOrderItems();
    initDates();
    clearMeasurementUI();
    updateStatus();

    // UI reset
    const btn = document.querySelector('.primary');
    if (btn && btn.innerText.includes("UPDATE")) btn.innerText = "💾 SAVE ORDER";

    document.getElementById('billNumber').focus();
}

// --- DATA FETCHING ---
function searchData(phone) {
    db.get("SELECT * FROM customers WHERE phone = ?", [phone], (err, customer) => {
        if (!err && customer) {
            document.getElementById('name').value = customer.name;
            loadMeasurements(customer.id);
            showStatus("Customer Loaded", "👤");
            
            // Enable quick history button
            const histBtn = document.getElementById('quickHistoryBtn');
            if (histBtn) {
                histBtn.style.display = 'flex';
                histBtn.dataset.cid = customer.id;
                histBtn.dataset.name = customer.name;
            }
        } else if (!customer) {
            showStatus("No customer found with this phone", "❌");
            const histBtn = document.getElementById('quickHistoryBtn');
            if (histBtn) histBtn.style.display = 'none';
        }
    });
}

window.viewHistoryFromForm = function() {
    const btn = document.getElementById('quickHistoryBtn');
    if (btn && btn.dataset.cid) {
        viewCustomerHistory(btn.dataset.cid, btn.dataset.name);
    }
};

window.triggerPhoneSearch = function () {
    const phone = document.getElementById('phone').value.trim();
    if (!phone) return showStatus("Please enter a phone number", "⚠️");
    searchData(phone);
};

// --- Legacy profiles removed ---

// --- SEARCH & EDIT ---
function searchOrders() {
    const q = (document.getElementById('orderSearch').value || "").toLowerCase();
    const isOverdueOnly = document.getElementById('overdueFilterToggle')?.checked;
    const today = new Date().toISOString().split('T')[0];

    let sql = `
        SELECT o.*, c.name FROM orders o 
        JOIN customers c ON o.customer_id = c.id 
        WHERE (LOWER(o.bill_number) LIKE ? OR LOWER(c.name) LIKE ? OR c.phone LIKE ?)
    `;
    let params = [`%${q}%`, `%${q}%`, `%${q}%`];

    if (isOverdueOnly) {
        sql += " AND o.delivery_date < ? AND (o.status IS NULL OR o.status != 'DELIVERED')";
        params.push(today);
    }

    sql += " ORDER BY o.id DESC LIMIT 100";

    db.all(sql, params, (err, rows) => {
        if (!err) renderHistoryRows(rows);
    });
}

function searchCustomers() {
    const q = (document.getElementById('customerSearch').value || "").toLowerCase();
    db.all("SELECT * FROM customers WHERE LOWER(name) LIKE ? OR phone LIKE ? ORDER BY created_at DESC LIMIT 200", [`%${q}%`, `%${q}%`], (err, rows) => {
        if (!err) renderCustomerRows(rows);
    });
}

function editOrder(oid) {
    db.get("SELECT o.*, c.name, c.phone FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.id = ?", [oid], (err, order) => {
        if (err || !order) return;

        // Populate Modal Fields
        document.getElementById('edit-billNumber').value = order.bill_number;
        document.getElementById('edit-phone').value = order.phone;
        document.getElementById('edit-name').value = order.name;
        document.getElementById('edit-givenDate').value = order.given_date;
        document.getElementById('edit-deliveryDate').value = order.delivery_date;
        document.getElementById('edit-notes').value = order.notes || "";
        document.getElementById('edit-shirt_notes').value = order.shirt_notes || "";
        document.getElementById('edit-pant_notes').value = order.pant_notes || "";

        // Load Measurements into Modal
        loadMeasurementsIntoModal(order.customer_id);

        // Open Modal
        document.getElementById('editOrderModal').classList.remove('hidden');
        editingOrderId = oid;

        showStatus("Editing Order #" + order.bill_number, "✏️");
    });
}

function loadMeasurementsIntoModal(customerId) {
    let shirt = undefined;
    let pant = undefined;

    const done = () => {
        if (shirt !== undefined && pant !== undefined) {
            // Fill Shirt Fields
            if (shirt) {
                Object.keys(shirt).forEach(key => {
                    const el = document.getElementById('edit-' + key);
                    if (el) el.value = shirt[key] || "";
                });
            }
            // Fill Pant Fields
            if (pant) {
                Object.keys(pant).forEach(key => {
                    const el = document.getElementById('edit-' + key);
                    if (el) el.value = pant[key] || "";
                });
            }
        }
    };

    db.get(`SELECT * FROM shirt_measurements WHERE customer_id = ?`, [customerId], (err, s) => {
        shirt = s || null;
        done();
    });

    db.get(`SELECT * FROM pant_measurements WHERE customer_id = ?`, [customerId], (err, p) => {
        pant = p || null;
        done();
    });
}

function closeEditModal() {
    document.getElementById('editOrderModal').classList.add('hidden');
    editingOrderId = null;
}

function toggleEditMeasurementType() {
    const type = document.getElementById("edit-measurementType").value;
    const shirt = document.getElementById("edit-shirtSection");
    const pant = document.getElementById("edit-pantSection");

    if (shirt) shirt.style.display = type === "shirt" ? "block" : "none";
    if (pant) pant.style.display = type === "pant" ? "block" : "none";
}

function updateOrderFromModal() {
    if (!editingOrderId) return;
    const oid = editingOrderId;
    const m = {};
    const inputs = document.querySelectorAll("#editOrderModal input, #editOrderModal select, #editOrderModal textarea");
    inputs.forEach(el => {
        if (el.id && el.id.startsWith('edit-')) {
            const key = el.id.replace('edit-', '');
            m[key] = el.value;
        }
    });

    db.get("SELECT id FROM orders WHERE bill_number = ? AND id != ?", [m.billNumber, oid], (err, row) => {
        if (row) {
            const billEl = document.getElementById('edit-billNumber');
            if (billEl) {
                billEl.style.borderColor = '#ef4444';
                billEl.style.boxShadow = '0 0 0 4px rgba(239, 68, 68, 0.2)';
                billEl.focus();
                setTimeout(() => { billEl.style.borderColor = ''; billEl.style.boxShadow = ''; }, 3000);
            }
            return showStatus("DUPLICATE BILL! This Bill Number already exists.", "❌");
        }
        proceedWithUpdate(oid, m);
    });
}

function proceedWithUpdate(oid, m) {
    const orderSql = `UPDATE orders SET bill_number=?, given_date=?, delivery_date=?, notes=?, shirt_notes=?, pant_notes=? WHERE id=?`;
    const orderParams = [m.billNumber, m.givenDate, m.deliveryDate, m.notes, m.shirt_notes, m.pant_notes, oid];

    db.run(orderSql, orderParams, (err) => {
        if (err) return showStatus("Failed to update order", "❌");

        // 2. Get customer_id for measurement update
        db.get("SELECT customer_id FROM orders WHERE id = ?", [oid], (err, row) => {
            if (err || !row) return;
            const cid = row.customer_id;

            // Update customer name in database
            db.run("UPDATE customers SET name=? WHERE id=?", [m.name, cid]);

            // 3. Save Measurements (Shirt & Pant)
            // SHIRT UPSERT
            const shirtSql = `INSERT INTO shirt_measurements (customer_id, length, chest, chest_correct, hip, hip_round, seat, seat_round, shoulder, sleeve_height, bicep_round, cuff_round_finish, neck, cuff_height, fit_style, front_patti_style, apple_cut)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET length=excluded.length, chest=excluded.chest, chest_correct=excluded.chest_correct, hip=excluded.hip, hip_round=excluded.hip_round, seat=excluded.seat, seat_round=excluded.seat_round, shoulder=excluded.shoulder, sleeve_height=excluded.sleeve_height, bicep_round=excluded.bicep_round, cuff_round_finish=excluded.cuff_round_finish, neck=excluded.neck, cuff_height=excluded.cuff_height, fit_style=excluded.fit_style, front_patti_style=excluded.front_patti_style, apple_cut=excluded.apple_cut`;
            const shirtParams = [cid, m.length, m.chest, m.chest_correct, m.hip, m.hip_round, m.seat, m.seat_round, m.shoulder, m.sleeve_height, m.bicep_round, m.cuff_round_finish, m.neck, m.cuff_height, m.fit_style, m.front_patti_style, m.apple_cut];

            // PANT UPSERT
            const pantSql = `INSERT INTO pant_measurements (customer_id, height, waist, seat_pant, thigh, knee_loose, bottom_loose, zip_length, in_seam, pant_type, pocket_type, back_pocket, mobile_pocket, watch_pocket)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET height=excluded.height, waist=excluded.waist, seat_pant=excluded.seat_pant, thigh=excluded.thigh, knee_loose=excluded.knee_loose, bottom_loose=excluded.bottom_loose, zip_length=excluded.zip_length, in_seam=excluded.in_seam, pant_type=excluded.pant_type, pocket_type=excluded.pocket_type, back_pocket=excluded.back_pocket, mobile_pocket=excluded.mobile_pocket, watch_pocket=excluded.watch_pocket`;
            const pantParams = [cid, m.height, m.waist, m.seat_pant, m.thigh, m.knee_loose, m.bottom_loose, m.zip_length, m.in_seam, m.pant_type, m.pocket_type, m.back_pocket, m.mobile_pocket, m.watch_pocket];

            db.serialize(() => {
                db.run(shirtSql, shirtParams);
                db.run(pantSql, pantParams, (err) => {
                    if (!err) {
                        // Store data for the success modal print button
                        pendingPrintData = {
                            info: {
                                bill_number: m.billNumber,
                                name: m.name,
                                phone: m.phone,
                                order_date: m.givenDate,
                                delivery_date: m.deliveryDate,
                                notes: m.notes,
                                shirt_notes: m.shirt_notes,
                                pant_notes: m.pant_notes
                            },
                            data: m
                        };

                        // Show Custom Success Modal
                        const hasShirt = (m.length || m.chest || m.shoulder);
                        const hasPant = (m.waist || m.height || m.thigh);
                        document.getElementById('success-print-shirt').style.display = hasShirt ? 'flex' : 'none';
                        document.getElementById('success-print-pant').style.display = hasPant ? 'flex' : 'none';
                        document.getElementById('success-print-both').style.display = (hasShirt && hasPant) ? 'flex' : 'none';

                        document.getElementById('successTitle').innerText = "Order Updated!";
                        document.getElementById('successMsg').innerText = `Order #${m.billNumber} has been updated successfully.`;
                        document.getElementById('successModal').classList.remove('hidden');

                        closeEditModal();
                        loadHistory(); // Refresh history table
                    }
                });
            });
        });
    });
}

window.viewAllOverdue = function () {
    const filter = document.getElementById('statusFilter');
    if (filter) filter.value = 'OVERDUE';
    showTab('orders');
    loadHistory();
};

function loadHistory() {
    const statusFilter = document.getElementById('statusFilter')?.value || 'ALL';
    const searchQuery = (document.getElementById('orderSearch')?.value || '').toLowerCase().trim();
    const today = new Date().toISOString().split('T')[0];

    let query = `
        SELECT o.*, c.name, c.phone,
        (SELECT COUNT(*) FROM shirt_measurements s WHERE s.customer_id = o.customer_id) as has_shirt,
        (SELECT COUNT(*) FROM pant_measurements p WHERE p.customer_id = o.customer_id) as has_pant
        FROM orders o 
        JOIN customers c ON o.customer_id = c.id
        WHERE 1=1
    `;
    let params = [];

    // 1. Apply Status Filter
    if (statusFilter === 'OVERDUE') {
        query += " AND o.delivery_date < ? AND (o.status IS NULL OR o.status != 'DELIVERED')";
        params.push(today);
    } else if (statusFilter === 'PENDING') {
        query += " AND (o.status IS NULL OR o.status != 'DELIVERED')";
    } else if (statusFilter === 'DELIVERED') {
        query += " AND o.status = 'DELIVERED'";
    }

    // 2. Apply Global Search
    if (searchQuery) {
        query += " AND (LOWER(c.name) LIKE ? OR c.phone LIKE ? OR LOWER(o.bill_number) LIKE ?)";
        params.push(`%${searchQuery}%`, `%${searchQuery}%`, `%${searchQuery}%`);
    }

    query += " ORDER BY o.id DESC LIMIT 100";

    db.all(query, params, (err, rows) => {
        if (!err) renderHistoryRows(rows);
    });
}

function renderHistoryRows(rows) {
    const tbody = document.getElementById('historyBody');
    const today = new Date().toISOString().split('T')[0];

    tbody.innerHTML = rows.map(r => {
        let rowClass = "";
        if (r.status !== 'DELIVERED') {
            if (r.delivery_date < today) rowClass = "overdue";
            else if (r.delivery_date === today) rowClass = "due-today";
        }

        return `
            <tr class="${rowClass}">
                <td style="font-weight: 800; color: #6366f1;">#${r.bill_number}</td>
                <td style="font-weight: 700;">${r.name}</td>
                <td style="font-size: 13px; color: #64748b;">
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <span class="material-symbols-outlined" style="font-size: 14px;">event</span>
                        ${r.delivery_date}
                    </div>
                </td>
                <td style="font-weight: 800; color: #1e293b;">₹ ${r.total}</td>
                <td>${getStatusHTML(r.status, r.delivery_date)}</td>
                <td>
                    <div class="actions-cell">
                        ${r.status !== 'DELIVERED'
                ? `<button class="btn-action btn-submit" onclick="openDeliveryModal(${r.id})">
                                <span class="material-symbols-outlined" style="font-size: 16px;">task_alt</span> Submit
                           </button>`
                : `<button class="btn-action btn-view" onclick="openDeliveryModal(${r.id})">
                                <span class="material-symbols-outlined" style="font-size: 16px;">visibility</span> View
                           </button>`
            }
                        <button class="btn-action btn-edit" title="Edit Order" onclick="editOrder(${r.id})">
                            <span class="material-symbols-outlined" style="font-size: 16px;">edit</span>
                        </button>
                        <div class="dropdown">
                            <button class="btn-action btn-bill" title="Print Bill" onclick="printBillFromData('${r.bill_number}', 'both')">
                                <span class="material-symbols-outlined" style="font-size: 16px;">receipt_long</span>
                                ${ (r.has_shirt > 0 && r.has_pant > 0) ? '▾' : '' }
                            </button>
                            ${ (r.has_shirt > 0 && r.has_pant > 0) ? `
                            <div class="dropdown-content">
                                <button onclick="printBillFromData('${r.bill_number}', 'both')">🧾 Full Bill</button>
                                <button onclick="printBillFromData('${r.bill_number}', 'shirt')">👕 Shirt Bill</button>
                                <button onclick="printBillFromData('${r.bill_number}', 'pant')">👖 Pant Bill</button>
                            </div>
                            ` : '' }
                        </div>
                        ${(r.has_shirt > 0 || r.has_pant > 0)
                ? `
                            <div class="dropdown">
                                <button class="btn-action btn-meas">
                                    <span class="material-symbols-outlined" style="font-size: 16px;">straighten</span>
                                    Meas ▾
                                </button>
                                <div class="dropdown-content">
                                    ${r.has_shirt > 0 ? `<button onclick="printOrderMeasurements(${r.id}, 'shirt')">👕 Shirt Only</button>` : ''}
                                    ${r.has_pant > 0 ? `<button onclick="printOrderMeasurements(${r.id}, 'pant')">👖 Pant Only</button>` : ''}
                                    ${(r.has_shirt > 0 && r.has_pant > 0) ? `<button onclick="printOrderMeasurements(${r.id}, 'both')">📜 Both</button>` : ''}
                                </div>
                            </div>
                            `
                : ''
            }
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function loadCustomers() {
    db.all("SELECT * FROM customers ORDER BY created_at DESC LIMIT 200", (err, rows) => {
        if (!err) renderCustomerRows(rows);
    });
}

function renderCustomerRows(rows) {
    const tbody = document.getElementById('customersBody');
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${r.name}</td>
            <td>${r.phone}</td>
            <td>${formatDateTime(r.created_at)}</td>
            <td style="text-align: right;">
                <button class="secondary" style="height: 28px; padding: 0 12px; border-color: #6366f1; color: #6366f1; font-weight: 700;" onclick="viewCustomerHistory(${r.id}, '${r.name.replace(/'/g, "\\'")}')">📜 History</button>
            </td>
        </tr>
    `).join('');
}

window.viewCustomerHistory = function (cid, name) {
    window.currentHistoryCustomerId = cid;
    document.getElementById('historyCustomerName').innerText = "Viewing activity for " + name;
    document.getElementById('customerHistoryModal').classList.remove('hidden');

    // Fetch History
    const sql = `
        SELECT o.*, GROUP_CONCAT(oi.quantity || 'x ' || oi.item_type, ', ') as item_summary
        FROM orders o 
        LEFT JOIN order_items oi ON o.id = oi.order_id
        WHERE o.customer_id = ?
        GROUP BY o.id
        ORDER BY o.given_date DESC
    `;

    db.all(sql, [cid], (err, rows) => {
        if (err) return showStatus("Failed to load history", "❌");

        const tbody = document.getElementById('historyListBody');
        if (!rows || rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 40px; color: #94a3b8;">No orders found for this customer.</td></tr>';
            document.getElementById('hist-total-orders').innerText = "0";
            document.getElementById('hist-total-spent').innerText = "₹ 0";
            document.getElementById('hist-total-balance').innerText = "₹ 0";
            return;
        }

        let totalSpent = 0;
        let totalBalance = 0;

        tbody.innerHTML = rows.map(r => {
            totalSpent += r.total;
            totalBalance += r.balance;

            const statusHtml = r.status === 'DELIVERED'
                ? '<span style="color: #10b981; font-weight: 800;">✅ DELIVERED</span>'
                : '<span style="color: #ef4444; font-weight: 800;">⏳ PENDING</span>';

            return `
                <tr style="border-bottom: 1px solid #f1f5f9;">
                    <td style="padding: 12px; font-size: 13px; font-weight: 600;">${r.given_date}</td>
                    <td style="padding: 12px; font-size: 12px; font-weight: 800; color: #6366f1;">#${r.bill_number}</td>
                    <td style="padding: 12px; font-size: 12px; color: #475569;">${r.item_summary || 'N/A'}</td>
                    <td style="padding: 12px;">
                        <div style="font-size: 13px; font-weight: 800; color: #000;">₹ ${r.total}</div>
                        <div style="font-size: 10px; font-weight: 700; color: ${r.balance > 0 ? '#ef4444' : '#64748b'};">Bal: ₹ ${r.balance}</div>
                    </td>
                    <td style="padding: 12px; font-size: 11px;">
                        ${statusHtml}
                        ${r.balance > 0 ? `
                            <button onclick="promptPayment(${r.id}, '${r.bill_number}', ${r.balance})" 
                                style="margin-left: 10px; background: #10b981; color: #fff; border: none; padding: 4px 8px; border-radius: 4px; font-size: 10px; font-weight: 800; cursor: pointer;">
                                💸 Pay
                            </button>
                        ` : ''}
                    </td>
                </tr>
            `;
        }).join('');

        // Update Stats
        document.getElementById('hist-total-orders').innerText = rows.length;
        document.getElementById('hist-total-spent').innerText = "₹ " + totalSpent;
        document.getElementById('hist-total-balance').innerText = "₹ " + totalBalance;
        document.getElementById('hist-total-balance').style.color = totalBalance > 0 ? '#ef4444' : '#10b981';
    });
};

window.closeHistoryModal = function() {
    document.getElementById('customerHistoryModal').classList.add('hidden');
};

window.switchHistTab = function(tab) {
    const ordersBtn = document.getElementById('hist-tab-orders');
    const paymentsBtn = document.getElementById('hist-tab-payments');
    const ordersView = document.getElementById('hist-orders-view');
    const paymentsView = document.getElementById('hist-payments-view');

    if (tab === 'orders') {
        ordersBtn.style.background = '#000'; 
        ordersBtn.style.color = '#fff';
        paymentsBtn.style.background = 'transparent'; 
        paymentsBtn.style.color = '#000';
        ordersView.classList.remove('hidden');
        paymentsView.classList.add('hidden');
    } else {
        paymentsBtn.style.background = '#000'; 
        paymentsBtn.style.color = '#fff';
        ordersBtn.style.background = 'transparent'; 
        ordersBtn.style.color = '#000';
        paymentsView.classList.remove('hidden');
        ordersView.classList.add('hidden');
        loadHistoryPayments();
    }
};

function loadHistoryPayments() {
    const custId = window.currentHistoryCustomerId;
    if (!custId) return;

    db.all(`
        SELECT p.*, o.bill_number 
        FROM payments p 
        JOIN orders o ON p.order_id = o.id 
        WHERE o.customer_id = ? 
        ORDER BY p.payment_date DESC
    `, [custId], (err, rows) => {
        const body = document.getElementById('historyPaymentsBody');
        if (err || !rows || rows.length === 0) {
            body.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#64748b;">No payment records found.</td></tr>';
            return;
        }

        body.innerHTML = rows.map(r => `
            <tr>
                <td style="padding: 12px; font-size: 13px; border-bottom: 1px solid #f1f5f9;">${new Date(r.payment_date).toLocaleDateString()}</td>
                <td style="padding: 12px; font-size: 13px; font-weight: 700; border-bottom: 1px solid #f1f5f9;">${r.bill_number}</td>
                <td style="padding: 12px; font-size: 13px; font-weight: 800; color: #10b981; border-bottom: 1px solid #f1f5f9;">₹ ${r.amount}</td>
                <td style="padding: 12px; font-size: 13px; border-bottom: 1px solid #f1f5f9;">${r.payment_mode}</td>
            </tr>
        `).join('');
    });
}
;

let currentPayingOrderId = null;

window.promptPayment = function(orderId, billNum, balance) {
    currentPayingOrderId = orderId;
    document.getElementById('paymentBillInfo').innerText = "Record payment for Bill #" + billNum;
    document.getElementById('maxPayAmount').innerText = balance;
    document.getElementById('payAmountInput').value = balance;
    document.getElementById('paymentModal').classList.remove('hidden');
};

window.closePaymentModal = function() {
    document.getElementById('paymentModal').classList.add('hidden');
};

window.submitPayment = async function() {
    const amount = parseFloat(document.getElementById('payAmountInput').value);
    const mode = document.getElementById('payModeInput').value;
    const max = parseFloat(document.getElementById('maxPayAmount').innerText);

    if (isNaN(amount) || amount <= 0) return showStatus("Enter a valid amount", "❌");
    if (amount > max) return showStatus("Amount exceeds balance", "⚠️");

    try {
        // 1. Insert into payments
        await db.run(`INSERT INTO payments (order_id, amount, payment_mode) VALUES (?, ?, ?)`, [currentPayingOrderId, amount, mode]);
        
        // 2. Update order balance
        await db.run(`UPDATE orders SET balance = balance - ? WHERE id = ?`, [amount, currentPayingOrderId]);
        
        showStatus("Payment recorded!", "✅");
        closePaymentModal();
        
        // 3. Refresh History
        const cid = window.currentHistoryCustomerId;
        const name = document.getElementById('historyCustomerName').innerText.replace("Viewing activity for ", "");
        viewCustomerHistory(cid, name);
        
    } catch (e) {
        console.error("Payment failed:", e);
        showStatus("Payment failed", "❌");
    }
};
window.useCustomerForOrder = function (cid, phone, name) {
    console.log("Using customer:", cid, name);
    try {
        const phoneInput = document.getElementById('phone');
        const nameInput = document.getElementById('name');

        if (phoneInput) phoneInput.value = phone;
        if (nameInput) nameInput.value = name;

        loadMeasurements(cid);
        showTab('new-order');
        showStatus("Measurements loaded for " + name, "📏");
    } catch (err) {
        console.error("Error in useCustomerForOrder:", err);
        showStatus("Failed to load customer data", "❌");
    }
};

// --- DELIVERY & STATUS ---
let currentDeliveryOrderId = null;
let currentDeliveryOrder = null; // Store full order for printing

function getStatusHTML(status, deliveryDate) {
    const today = new Date().toISOString().split('T')[0];
    
    if (status === "DELIVERED") {
        return `<span class="status-badge status-delivered">
                    <span class="material-symbols-outlined" style="font-size: 14px;">check_circle</span>
                    Delivered
                </span>`;
    }
    
    if (deliveryDate < today) {
        return `<span class="status-badge status-overdue">
                    <span class="material-symbols-outlined" style="font-size: 14px;">warning</span>
                    Overdue
                </span>`;
    }
    
    if (deliveryDate === today) {
        return `<span class="status-badge status-today">
                    <span class="material-symbols-outlined" style="font-size: 14px;">notifications_active</span>
                    Due Today
                </span>`;
    }

    return `<span class="status-badge status-pending">
                <span class="material-symbols-outlined" style="font-size: 14px;">pending</span>
                Order Placed
            </span>`;
}

function openDeliveryModal(orderId) {
    db.get("SELECT o.*, c.name as customer_name FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.id = ?", [orderId], (err, order) => {
        if (err || !order) return;
        currentDeliveryOrderId = orderId;
        currentDeliveryOrder = order;

        const balance = order.total - order.advance;
        const isDelivered = order.status === 'DELIVERED';

        document.getElementById('modalTitle').innerText = isDelivered ? "Order Details" : "Submit Delivery";
        document.getElementById('modalOrderInfo').innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <p><span>Customer:</span> <b>${order.customer_name}</b></p>
                <p><span>Bill Number:</span> <b>${order.bill_number}</b></p>
                <div style="display: grid; grid-template-cols: 1fr 1fr; gap: 10px; margin-top: 4px; padding: 8px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;">
                    <div>
                        <div style="font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: 600;">Order Date</div>
                        <div style="font-size: 13px; font-weight: 700;">${order.given_date}</div>
                    </div>
                    <div>
                        <div style="font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: 600;">Delivery Date</div>
                        <div style="font-size: 13px; font-weight: 700; color: var(--primary);">${order.delivery_date}</div>
                    </div>
                </div>
            </div>
            <hr style="margin: 15px 0; border: 0; border-top: 1px solid var(--border);">
            <p><span>Total Amount:</span> <span>₹ ${order.total}</span></p>
            <p><span>Advance Paid:</span> <span>₹ ${order.advance}</span></p>
            <p style="font-size: 16px; margin-top: 5px;"><span>Balance Due:</span> <b style="color:var(--danger);">₹ ${balance}</b></p>
            ${isDelivered ? `
                <hr style="margin: 15px 0; border: 0; border-top: 1px solid var(--border);">
                <p><span>Payment Mode:</span> <b>${order.payment_mode || 'N/A'}</b></p>
                <p><span>Final Paid:</span> <b style="color:var(--success);">₹ ${order.final_payment || 0}</b></p>
            ` : ''}
        `;

        const paymentSection = document.getElementById('paymentSection');
        const actionBtn = document.getElementById('modalActionBtn');

        if (isDelivered) {
            paymentSection.classList.add('hidden');
            actionBtn.innerText = "🖨️ Print Bill";
            actionBtn.onclick = () => { printBillA5(order); closeModal(); };
        } else {
            paymentSection.classList.remove('hidden');
            document.getElementById('finalPaymentAmount').value = balance;
            actionBtn.innerText = "✅ Confirm Delivery";
            actionBtn.onclick = submitDelivery;
        }

        document.getElementById('deliveryModal').classList.remove('hidden');
    });
}

function closeModal() {
    document.getElementById('deliveryModal').classList.add('hidden');
    currentDeliveryOrderId = null;
    currentDeliveryOrder = null;
}

function submitDelivery() {
    const mode = document.getElementById('paymentMode').value;
    const final = parseFloat(document.getElementById('finalPaymentAmount').value) || 0;

    db.run("UPDATE orders SET status = 'DELIVERED', payment_mode = ?, final_payment = ? WHERE id = ?", [mode, final, currentDeliveryOrderId], (err) => {
        if (!err) {
            showStatus("Order Delivered & Printing Bill...", "🖨️");

            // Trigger A5 Print with current data
            printBillA5(currentDeliveryOrder);

            closeModal();
            loadHistory();
            loadDashboardStats();
            loadDeliveries();
        }
    });
}

// --- A5 BILL PRINTING (RECEIPT STYLE) ---
function printBillA5(orderRef) {
    // If we only have an ID or bill_number, fetch the full record first to be safe
    const sql = orderRef.id ?
        "SELECT o.*, c.name as customer_name FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.id = ?" :
        "SELECT o.*, c.name as customer_name FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.bill_number = ?";
    const param = orderRef.id || orderRef.bill_number;

    db.get(sql, [param], (err, order) => {
        if (err || !order) {
            console.error("Print fetch failed:", err);
            return showStatus("Could not fetch bill data", "❌");
        }

        db.all("SELECT * FROM order_items WHERE order_id = ?", [order.id], (err, items) => {
            if (err) return;

            const htmlContent = `
                <html>
                <head>
                    <title>Bill #${order.bill_number}</title>
                    <style>
                        * { box-sizing: border-box; font-family: 'Inter', 'Segoe UI', Arial, sans-serif; color: #000; }
                        body { margin: 0; padding: 20px; background: #fff; }
                        
                        .print-btn-container { text-align: center; margin-bottom: 20px; }
                        .print-btn { background: #000; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; }
                        
                        .bill-wrapper { 
                            width: 100%;
                            max-width: 750px;
                            margin: 0 auto;
                            padding: 30px;
                            border: 1px solid #000;
                        }

                        @media print {
                            body { padding: 0; }
                            .print-btn-container { display: none; }
                            .bill-wrapper { border: none; padding: 0; width: 100%; }
                            @page { size: A5 landscape; margin: 10mm; }
                        }

                        .header { text-align: center; margin-bottom: 10px; }
                        .header h1 { margin: 0; font-size: 28px; font-weight: 900; text-transform: uppercase; letter-spacing: 2px; }
                        .header p { margin: 2px 0; font-size: 12px; font-weight: 600; color: #333; }
                        
                        .main-divider { border-top: 2.5px solid #000; margin: 15px 0; }

                        .info-section { width: 100%; display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 13px; }
                        .info-column { flex: 1; }
                        .info-row { margin-bottom: 4px; display: flex; }
                        .info-label { font-weight: 800; width: 80px; text-transform: uppercase; font-size: 11px; }
                        .info-value { font-weight: 600; }

                        table { width: 100%; border-collapse: collapse; margin-bottom: 15px; border: 1.5px solid #000; }
                        th, td { border: 1px solid #000; padding: 10px 12px; font-size: 13px; }
                        th { background: #f5f5f5; font-weight: 900; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
                        
                        .col-item { text-align: left; width: 50%; }
                        .col-qty { text-align: center; width: 10%; }
                        .col-price { text-align: right; width: 20%; }
                        .col-total { text-align: right; width: 20%; }

                        .summary-wrapper { width: 100%; display: flex; justify-content: flex-end; }
                        .summary-table { width: 250px; border-collapse: collapse; border: none; }
                        .summary-table td { border: none; padding: 4px 0; font-size: 14px; }
                        .summary-label { text-align: left; font-weight: 700; color: #444; }
                        .summary-value { text-align: right; font-weight: 800; font-size: 15px; }
                        
                        .balance-row td { padding-top: 8px; border-top: 1px solid #000; font-size: 18px !important; font-weight: 900 !important; }

                        .footer { margin-top: 40px; text-align: center; border-top: 1px solid #eee; padding-top: 15px; }
                        .thanks { font-size: 14px; font-weight: 800; margin-bottom: 5px; }
                        .visit { font-size: 11px; color: #666; font-style: italic; }
                    </style>
                </head>
                <body>
                    <div class="no-print" style="text-align: center; padding: 10px; background: #000; position: sticky; top: 0; z-index: 1000; margin-bottom: 20px; display: flex; justify-content: center; gap: 15px; align-items: center; border-bottom: 2px solid #333;">
                        <button onclick="sendToPrinter()" style="padding: 8px 25px; font-size: 14px; font-weight: bold; background: #22c55e; color: #fff; border: none; cursor: pointer; border-radius: 4px;">🖨️ PRINT</button>
                        <button onclick="window.close()" style="padding: 8px 20px; font-size: 14px; font-weight: bold; background: #444; color: #fff; border: none; cursor: pointer; border-radius: 4px;">CLOSE</button>
                    </div>
                    <div class="bill-wrapper">
                        <div class="header">
                            <h1>CRMA TAILORS</h1>
                            <p>Specialist in Gents & Ladies Wear</p>
                        </div>
                        
                        <div class="main-divider"></div>

                        <div class="info-section">
                            <div class="info-column">
                                <div class="info-row"><span class="info-label">Bill No:</span> <span class="info-value">#${order.bill_number}</span></div>
                                <div class="info-row"><span class="info-label">Customer:</span> <span class="info-value">${order.customer_name}</span></div>
                            </div>
                            <div class="info-column" style="text-align: right; display: flex; flex-direction: column; align-items: flex-end;">
                                <div class="info-row"><span class="info-label">Order Date:</span> <span class="info-value">${order.given_date}</span></div>
                                <div class="info-row"><span class="info-label">Delivery:</span> <span class="info-value" style="color: #000;">${order.delivery_date}</span></div>
                            </div>
                        </div>

                        <table>
                            <thead>
                                <tr>
                                    <th class="col-item">Item Description</th>
                                    <th class="col-qty">Qty</th>
                                    <th class="col-price">Unit Price</th>
                                    <th class="col-total">Total Amount</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${items.map(i => `
                                    <tr>
                                        <td class="col-item" style="font-weight: 700;">${i.item_type}</td>
                                        <td class="col-qty">${i.quantity}</td>
                                        <td class="col-price">₹ ${i.price.toLocaleString('en-IN')}</td>
                                        <td class="col-total">₹ ${i.amount.toLocaleString('en-IN')}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>

                        <div class="summary-wrapper">
                            <table class="summary-table">
                                <tr>
                                    <td class="summary-label">Total Amount:</td>
                                    <td class="summary-value">₹ ${order.total.toLocaleString('en-IN')}</td>
                                </tr>
                                <tr>
                                    <td class="summary-label">Advance Paid:</td>
                                    <td class="summary-value">₹ ${order.advance.toLocaleString('en-IN')}</td>
                                </tr>
                                <tr class="balance-row">
                                    <td class="summary-label">Balance Due:</td>
                                    <td class="summary-value">₹ ${(order.total - order.advance).toLocaleString('en-IN')}</td>
                                </tr>
                            </table>
                        </div>

                        <div class="footer">
                            <div class="thanks">Thank you for choosing Croma Tailors!</div>
                            <div class="visit">We look forward to seeing you again for the best tailoring experience.</div>
                        </div>
                    </div>
                </body>
                <script>
                    const { ipcRenderer } = require('electron');
                    function sendToPrinter() {
                        ipcRenderer.send('trigger-final-print');
                    }
                </script>
                </html>
            `;
            ipcRenderer.invoke('print-html', htmlContent);
        });
    });
}

// --- PROFESSIONAL PRINTING ---
function printBillFromData(billNumber, filterType = 'both') {
    db.get("SELECT o.*, c.name as customer_name, c.phone as customer_phone FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.bill_number = ?", [billNumber], (err, order) => {
        if (err || !order) return showStatus("Bill not found", "❌");

        db.all("SELECT * FROM order_items WHERE order_id = ?", [order.id], (err, items) => {
            if (err) return;

            // Apply filter if needed
            let filteredItems = items;
            if (filterType === 'shirt') {
                filteredItems = items.filter(i => i.item_type.toLowerCase().includes('shirt'));
            } else if (filterType === 'pant') {
                filteredItems = items.filter(i => i.item_type.toLowerCase().includes('pant'));
            }

            if (filteredItems.length === 0) {
                return showStatus(`No ${filterType} items found in this bill.`, "⚠️");
            }

            const htmlContent = `
                <html>
                <head>
                    <title>Bill #${order.bill_number}</title>
                    <style>
                        * { box-sizing: border-box; font-family: 'Inter', 'Segoe UI', Arial, sans-serif; color: #000; }
                        body { margin: 0; padding: 40px; background: #fff; }
                        
                        .print-btn-container { text-align: center; margin-bottom: 30px; }
                        .print-btn { background: #4f46e5; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-weight: bold; }
                        
                        .bill-wrapper { 
                            width: 100%;
                            max-width: 750px;
                            margin: 0 auto;
                            padding: 30px;
                            border: 1px solid #000;
                        }

                        @media print {
                            body { padding: 0; }
                            .print-btn-container { display: none; }
                            .bill-wrapper { border: none; padding: 0; width: 100%; }
                            @page { size: A5 landscape; margin: 10mm; }
                        }

                        .header { text-align: center; margin-bottom: 10px; }
                        .header h1 { margin: 0; font-size: 28px; font-weight: 900; text-transform: uppercase; letter-spacing: 2px; }
                        .header p { margin: 2px 0; font-size: 12px; font-weight: 600; color: #333; }
                        
                        .main-divider { border-top: 2.5px solid #000; margin: 15px 0; }

                        .info-section { width: 100%; display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 13px; }
                        .info-column { flex: 1; }
                        .info-row { margin-bottom: 4px; display: flex; }
                        .info-label { font-weight: 800; width: 80px; text-transform: uppercase; font-size: 11px; }
                        .info-value { font-weight: 600; }

                        table { width: 100%; border-collapse: collapse; margin-bottom: 15px; border: 1.5px solid #000; }
                        th, td { border: 1px solid #000; padding: 10px 12px; font-size: 13px; }
                        th { background: #f5f5f5; font-weight: 900; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
                        
                        .col-item { text-align: left; width: 50%; }
                        .col-qty { text-align: center; width: 10%; }
                        .col-price { text-align: right; width: 20%; }
                        .col-total { text-align: right; width: 20%; }

                        .summary-wrapper { width: 100%; display: flex; justify-content: flex-end; }
                        .summary-table { width: 250px; border-collapse: collapse; border: none; }
                        .summary-table td { border: none; padding: 4px 0; font-size: 14px; }
                        .summary-label { text-align: left; font-weight: 700; color: #444; }
                        .summary-value { text-align: right; font-weight: 800; font-size: 15px; }
                        
                        .balance-row td { padding-top: 8px; border-top: 1px solid #000; font-size: 18px !important; font-weight: 900 !important; }

                        .footer { margin-top: 40px; text-align: center; border-top: 1px solid #eee; padding-top: 15px; }
                        .thanks { font-size: 14px; font-weight: 800; margin-bottom: 5px; }
                        .visit { font-size: 11px; color: #666; font-style: italic; }
                    </style>
                </head>
                <body>
                    <div class="print-btn-container">
                        <button class="print-btn" onclick="window.print()">🖨️ PRINT FINAL BILL</button>
                    </div>
                    <div class="bill-wrapper">
                        <div class="header">
                            <h1>CRMA TAILORS</h1>
                            <p>Specialist in Gents & Ladies Wear</p>
                        </div>
                        
                        <div class="main-divider"></div>

                        <div class="info-section">
                            <div class="info-column">
                                <div class="info-row"><span class="info-label">Bill No:</span> <span class="info-value">#${order.bill_number} ${filterType !== 'both' ? `(${filterType.toUpperCase()})` : ''}</span></div>
                                <div class="info-row"><span class="info-label">Customer:</span> <span class="info-value">${order.customer_name}</span></div>
                            </div>
                            <div class="info-column" style="text-align: right; display: flex; flex-direction: column; align-items: flex-end;">
                                <div class="info-row"><span class="info-label">Order Date:</span> <span class="info-value">${order.given_date}</span></div>
                                <div class="info-row"><span class="info-label">Delivery:</span> <span class="info-value" style="color: #000;">${order.delivery_date}</span></div>
                            </div>
                        </div>

                        <table>
                            <thead>
                                <tr>
                                    <th class="col-item">Item Description</th>
                                    <th class="col-qty">Qty</th>
                                    <th class="col-price">Unit Price</th>
                                    <th class="col-total">Total Amount</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${filteredItems.map(i => `
                                    <tr>
                                        <td class="col-item" style="font-weight: 700;">${i.item_type}</td>
                                        <td class="col-qty">${i.quantity}</td>
                                        <td class="col-price">₹ ${i.price.toLocaleString('en-IN')}</td>
                                        <td class="col-total">₹ ${i.amount.toLocaleString('en-IN')}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>

                        <div class="summary-wrapper">
                            <table class="summary-table">
                                <tr>
                                    <td class="summary-label">Subtotal</td>
                                    <td class="summary-value">₹ ${filteredItems.reduce((s, i) => s + i.amount, 0).toLocaleString('en-IN')}</td>
                                </tr>
                                ${filterType === 'both' ? `
                                <tr>
                                    <td class="summary-label">Advance Paid</td>
                                    <td class="summary-value">₹ ${order.advance.toLocaleString('en-IN')}</td>
                                </tr>
                                <tr class="balance-row">
                                    <td class="summary-label" style="color: #ef4444;">Balance Due</td>
                                    <td class="summary-value" style="color: #ef4444;">₹ ${(filteredItems.reduce((s, i) => s + i.amount, 0) - order.advance).toLocaleString('en-IN')}</td>
                                </tr>
                                ` : `
                                <tr>
                                    <td colspan="2" style="font-size: 10px; color: #666; font-style: italic; text-align: right; padding-top: 10px;">
                                        * This is a partial bill for ${filterType}.<br>Advance & Balance shown on full bill.
                                    </td>
                                </tr>
                                `}
                            </table>
                        </div>

                        <div class="footer">
                            <div class="thanks">Thank you for choosing Croma Tailors!</div>
                            <div class="visit">We look forward to seeing you again for the best tailoring experience.</div>
                        </div>
                    </div>
                    <script>
                        window.onafterprint = () => window.close();
                    </script>
                </body>
                </html>
            `;
            ipcRenderer.invoke('print-html', htmlContent);
        });
    });
}

// --- UTILS ---
function showStatus(msg, typeOrIcon) {
    const overlay = document.getElementById('statusOverlay');
    const message = document.getElementById('statusMessage');
    const icon = document.getElementById('statusIcon');
    const progress = document.getElementById('statusProgress');

    if (!overlay) return;

    // Determine type and icon
    let type = 'info';
    let iconContent = typeOrIcon;

    if (typeOrIcon === '✅' || msg.toLowerCase().includes('saved') || msg.toLowerCase().includes('success')) {
        type = 'success';
        iconContent = 'check_circle';
    } else if (typeOrIcon === '❌' || msg.toLowerCase().includes('failed') || msg.toLowerCase().includes('error')) {
        type = 'error';
        iconContent = 'error';
    } else if (typeOrIcon === '🔄' || typeOrIcon === '⏳') {
        type = 'info';
        iconContent = 'sync';
    }

    // Reset classes
    overlay.className = 'fade-in';
    overlay.classList.add('toast-' + type);

    // Set content
    message.innerText = msg;
    icon.innerHTML = `<span class="material-symbols-outlined">${iconContent}</span>`;

    // Animate progress bar
    progress.style.transition = 'none';
    progress.style.width = '100%';

    overlay.classList.remove('hidden');

    // Start progress bar shrink
    setTimeout(() => {
        progress.style.transition = 'width 3s linear';
        progress.style.width = '0%';
    }, 10);

    // Hide after 3 seconds
    setTimeout(() => {
        overlay.classList.add('hidden');
    }, 3000);
}

function formatDateTime(dateString) {
    if (!dateString) return "N/A";

    // Support both SQL format (no T) and ISO format
    const d = new Date(dateString.replace(" ", "T"));
    if (isNaN(d.getTime())) return "Invalid Date";

    const now = new Date();

    // Relative labels
    const isToday = now.toDateString() === d.toDateString();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = yesterday.toDateString() === d.toDateString();

    const timeStr = d.toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

    if (isToday) return `<span style="color:var(--primary); font-weight:600;">Today</span>, ${timeStr}`;
    if (isYesterday) return `<span style="color:var(--text-secondary);">Yesterday</span>, ${timeStr}`;

    return d.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
    });
}

function exportCSV(type) {
    const sql = type === 'customers' ? "SELECT * FROM customers" : "SELECT o.*, c.name as customer_name FROM orders o JOIN customers c ON o.customer_id = c.id";

    db.all(sql, (err, rows) => {
        if (err || !rows.length) return showStatus("No data to export", "❌");

        const headers = Object.keys(rows[0]).join(",");
        const content = rows.map(r => Object.values(r).map(v => `"${v}"`).join(",")).join("\n");
        const csv = headers + "\n" + content;

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tailor_${type}_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showStatus("Data Exported!", "📊");
    });
}

// --- AUTO BACKUP SYSTEM ---
const backupDir = path.join(os.homedir(), "Documents", "TailorBackup");

function ensureBackupDir() {
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
}

function backupDB() {
    try {
        ensureBackupDir();
        const today = new Date().toISOString().split("T")[0];
        const backupFile = path.join(backupDir, `backup_${today}.db`).replace(/\\/g, '/');

        // Avoid duplicate backup same day
        if (fs.existsSync(backupFile)) {
            console.log("Backup already exists for today");
            return;
        }

        // SQLite VACUUM INTO is the cleanest way to clone a live DB
        db.exec(`VACUUM INTO '${backupFile}'`, (err) => {
            if (err) {
                console.error("Backup failed:", err);
            } else {
                console.log("Backup successful:", backupFile);
                cleanOldBackups();
            }
        });
    } catch (err) {
        console.error("Backup error:", err);
    }
}

function cleanOldBackups() {
    try {
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith("backup_") && f.endsWith(".db"))
            .sort()
            .reverse();

        const oldFiles = files.slice(7); // Keep 7 days
        oldFiles.forEach(file => {
            const filePath = path.join(backupDir, file);
            fs.unlinkSync(filePath);
            console.log("Deleted old backup:", file);
        });
    } catch (err) {
        console.error("Cleanup error:", err);
    }
}

// --- RESTORE SYSTEM ---
function loadBackupList() {
    const list = document.getElementById("backupList");
    if (!list) return;

    // Show loading state
    list.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--text-secondary);">🔄 Scanning for backups...</div>`;

    setTimeout(() => {
        try {
            ensureBackupDir();
            const files = fs.readdirSync(backupDir)
                .filter(f => f.startsWith("backup_") && f.endsWith(".db"))
                .sort()
                .reverse();

            if (files.length === 0) {
                list.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--text-secondary);">No backups found in Documents/TailorBackup</div>`;
                return;
            }

            list.innerHTML = files.map(file => {
                const stats = fs.statSync(path.join(backupDir, file));
                const dateStr = stats.mtime.toLocaleString("en-IN", {
                    day: '2-digit', month: 'short', year: 'numeric',
                    hour: '2-digit', minute: '2-digit', hour12: true
                });

                return `
                    <div class="backup-item fade-in" style="background: #fff; border: 1.5px solid #000; border-radius: 8px; padding: 12px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                        <div class="file-info">
                            <div class="file-name" style="font-weight: 800; font-size: 14px;">📦 ${file}</div>
                            <div class="file-date" style="font-size: 12px; color: #64748b;">Saved on ${dateStr}</div>
                        </div>
                        <button class="secondary" style="height:32px; font-size:12px; border: 1.5px solid #000; font-weight: 700;" onclick="window.restoreBackup('${file}')">⏪ Restore</button>
                    </div>
                `;
            }).join('');

            showStatus("Backup list updated", "🔄");
        } catch (err) {
            console.error("Failed to load backups:", err);
            list.innerHTML = `<div style="color: var(--danger); padding: 20px;">Error reading backups directory.</div>`;
            showStatus("Failed to refresh list", "❌");
        }
    }, 300); // Small delay for visual feedback
}

async function restoreBackup(fileName) {
    const backupPath = path.join(backupDir, fileName);

    const confirmRestore = confirm(
        "⚠️ CAUTION: RESTORE DATA\n\n" +
        "This will permanently overwrite your current shop data with the selected backup.\n\n" +
        "ARE YOU ABSOLUTELY SURE?"
    );

    if (!confirmRestore) return;

    showStatus("Restoring data...", "⏳");

    try {
        await ipcRenderer.invoke('db-restore', backupPath);
        // Note: The main process will reload/relaunch the app.
    } catch (err) {
        console.error("RESTORATION FAILED:", err);
        showStatus("Restore failed! Check console.", "❌");
        alert("CRITICAL ERROR: Could not restore database.");
    }
}

function confirmFactoryReset() {
    const confirmReset = confirm("⚠️ FACTORY RESET\n\nThis will DELETE ALL DATA and start fresh. This CANNOT be undone.\n\nType 'RESET' in your mind then click OK if you are sure.");
    if (confirmReset) {
        alert("Please contact support or manually delete database.db for factory reset protection.");
    }
}

// Global exposure
window.addItem = addItem;
window.removeItem = removeItem;
window.saveOrderFinal = saveOrderFinal;
window.exportCSV = exportCSV;
window.loadBackupList = loadBackupList;
window.restoreBackup = restoreBackup;
window.toggleMeasurementType = toggleMeasurementType;
window.closeEditModal = closeEditModal;
window.toggleEditMeasurementType = toggleEditMeasurementType;
window.updateOrderFromModal = updateOrderFromModal;
// --- DATA EXPORT ---

function printMeasurements(forceType = 'both') {
    const data = collectMeasurements();
    const customerInfo = {
        name: document.getElementById("name")?.value || "N/A",
        phone: document.getElementById("phone")?.value || "N/A",
        bill_number: document.getElementById("billNumber")?.value || "N/A",
        order_date: document.getElementById("givenDate")?.value || "N/A",
        delivery_date: document.getElementById("deliveryDate")?.value || "N/A",
        notes: document.getElementById("notes")?.value || "",
        shirt_notes: document.getElementById("shirt_notes")?.value || "",
        pant_notes: document.getElementById("pant_notes")?.value || ""
    };
    generateMeasurementSlip(customerInfo, data, forceType);
}

window.printShirtOnly = function() {
    if (pendingPrintData) {
        generateMeasurementSlip(pendingPrintData.info, pendingPrintData.data, 'shirt');
    } else {
        printMeasurements('shirt');
    }
    window.closeSuccessModal();
};

window.printPantOnly = function() {
    if (pendingPrintData) {
        generateMeasurementSlip(pendingPrintData.info, pendingPrintData.data, 'pant');
    } else {
        printMeasurements('pant');
    }
    window.closeSuccessModal();
};

window.printBothMeasurements = function() {
    if (pendingPrintData) {
        generateMeasurementSlip(pendingPrintData.info, pendingPrintData.data, 'both');
    } else {
        printMeasurements('both');
    }
    window.closeSuccessModal();
};

function collectEditMeasurements() {
    const data = {};
    const shirtKeys = ['length', 'chest', 'chest_correct', 'hip', 'hip_round', 'seat', 'seat_round', 'shoulder', 'sleeve_height', 'bicep_round', 'cuff_round_finish', 'neck', 'cuff_height', 'fit_style', 'front_patti_style', 'apple_cut'];
    shirtKeys.forEach(k => {
        const el = document.getElementById('edit-' + k);
        if (el) data[k] = el.value;
    });
    const pantKeys = ['height', 'waist', 'seat_pant', 'thigh', 'knee_loose', 'bottom_loose', 'zip_length', 'in_seam', 'pant_type', 'pocket_type', 'back_pocket', 'mobile_pocket', 'watch_pocket'];
    pantKeys.forEach(k => {
        const el = document.getElementById('edit-' + k);
        if (el) data[k] = el.value;
    });
    return data;
}

window.printShirtFromEdit = function () {
    const data = collectEditMeasurements();
    const info = {
        bill_number: document.getElementById('edit-billNumber').value,
        name: document.getElementById('edit-name').value,
        order_date: document.getElementById('edit-givenDate').value,
        delivery_date: document.getElementById('edit-deliveryDate').value,
        notes: document.getElementById('edit-notes').value,
        shirt_notes: document.getElementById('edit-shirt_notes').value,
        pant_notes: document.getElementById('edit-pant_notes').value,
        phone: document.getElementById('edit-phone').value
    };
    generateMeasurementSlip(info, data, 'shirt');
};

window.printPantFromEdit = function () {
    const data = collectEditMeasurements();
    const info = {
        bill_number: document.getElementById('edit-billNumber').value,
        name: document.getElementById('edit-name').value,
        order_date: document.getElementById('edit-givenDate').value,
        delivery_date: document.getElementById('edit-deliveryDate').value,
        notes: document.getElementById('edit-notes').value,
        shirt_notes: document.getElementById('edit-shirt_notes').value,
        pant_notes: document.getElementById('edit-pant_notes').value,
        phone: document.getElementById('edit-phone').value
    };
    generateMeasurementSlip(info, data, 'pant');
};

window.printBothFromEdit = function () {
    const data = collectEditMeasurements();
    const info = {
        bill_number: document.getElementById('edit-billNumber').value,
        name: document.getElementById('edit-name').value,
        order_date: document.getElementById('edit-givenDate').value,
        delivery_date: document.getElementById('edit-deliveryDate').value,
        notes: document.getElementById('edit-notes').value,
        shirt_notes: document.getElementById('edit-shirt_notes').value,
        pant_notes: document.getElementById('edit-pant_notes').value,
        phone: document.getElementById('edit-phone').value
    };
    generateMeasurementSlip(info, data, 'both');
};

function printOrderMeasurements(orderId, forceType = 'both') {
    db.get("SELECT o.*, c.name, c.phone FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.id = ?", [orderId], (err, order) => {
        if (err || !order) return;

        let shirtData = null;
        let pantData = null;

        const checkDone = () => {
            if (shirtData !== null && pantData !== null) {
                // Map database fields to template expected fields
                const printInfo = {
                    ...order,
                    order_date: order.given_date, // Map given_date to order_date
                    delivery_date: order.delivery_date
                };

                const combinedData = { ...shirtData, ...pantData };
                generateMeasurementSlip(printInfo, combinedData, forceType);
            }
        };

        db.get("SELECT * FROM shirt_measurements WHERE customer_id = ?", [order.customer_id], (err, s) => {
            shirtData = s || {};
            checkDone();
        });

        db.get("SELECT * FROM pant_measurements WHERE customer_id = ?", [order.customer_id], (err, p) => {
            pantData = p || {};
            checkDone();
        });
    });
}

function generateMeasurementSlip(customerInfo, data, forceType = 'both') {
    const hasShirt = (forceType === 'shirt') || (forceType === 'both');
    const hasPant = (forceType === 'pant') || (forceType === 'both');

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap" rel="stylesheet">
        <style>
            /* 1. Core print settings for A5 Portrait */
            @page {
                size: A5 portrait;
                margin: 0mm 8mm 8mm 8mm; /* Remove top margin entirely */
            }

            @media print {
                /* Hide UI elements like buttons during print */
                .no-print, #print-btn, .action-bar {
                    display: none !important;
                }

                body {
                    width: 148mm;
                    height: 210mm;
                    margin: 0;
                    padding: 0;
                    -webkit-print-color-adjust: exact;
                    print-color-adjust: exact;
                    background-color: white;
                    font-family: 'Inter', sans-serif;
                }
            }

            body {
                font-family: 'Inter', sans-serif;
                margin: 0;
                padding: 0;
                color: #000;
            }

        <style>
            @page {
                size: A5;
                margin: 0;
            }
            body {
                margin: 0;
                padding: 0;
                font-family: 'Inter', -apple-system, sans-serif;
                background: #f4f4f4;
            }
            * { box-sizing: border-box; }

            .page {
                width: 148mm;
                height: 210mm;
                background: white;
                margin: 0 auto;
                padding: 8mm;
                display: flex;
                flex-direction: column;
                page-break-after: always;
                position: relative;
                overflow: hidden;
            }
            .page:last-child { page-break-after: auto; }

            .header-box {
                text-align: center;
                border-bottom: 2.5px solid #000;
                padding-bottom: 8px;
                margin-bottom: 10px;
            }
            .header-box h1 {
                display: none;
            }
            .header-box .label {
                font-size: 18px;
                font-weight: 500;
                text-transform: uppercase;
                display: block;
                margin-top: 10px;
                margin-bottom: 20px;
            }

            .content {
                flex: 1;
                display: flex;
                flex-direction: column;
                gap: 14px; /* Best Fix: 14px */
            }

            .top-section {
                flex: 0; /* Don't force stretch */
            }

            .top-info {
                display: flex;
                flex-direction: column;
                gap: 4px;
                font-size: 13px;
                margin-bottom: 25px;
            }
            .info-item {
                display: flex;
                align-items: center;
                line-height: 1.4;
            }
            .info-label {
                font-weight: normal;
                width: 110px;
                color: #000;
            }
            .info-value {
                font-weight: 500;
                color: #000;
                padding-left: 12px;
                border-left: 1.5px solid #000;
            }

            .measurement-section {
                display: flex;
                justify-content: space-between;
                margin-top: 5px;
            }
            .col-left, .col-right {
                width: 48%;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .field-row {
                display: flex;
                align-items: center;
                height: 28px;
            }
            .label-text {
                font-size: 12px;
                font-weight: normal;
                width: 85px;
                color: #000;
            }
            .m-boxes {
                display: flex;
                gap: 5px;
            }
            .data-box {
                border: 1px solid black;
                text-align: center;
                padding: 0px 5px;
                font-size: 13px;
                font-weight: 500;
                background: #fff;
                height: 24px;
                width: 60px;
                display: flex;
                align-items: center;
                justify-content: center;
                text-transform: uppercase;
            }
            .data-box.small { width: 40px; }
            .data-box.wide { width: 85px; }

            .footer-notes {
                margin-top: 20px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .footer-row {
                display: flex;
                font-size: 12px;
            }
            .footer-label {
                font-weight: normal;
                width: 100px;
            }
            .footer-val {
                font-weight: 500;
            }
                top: -9px;
                left: 10px;
                background: #fff;
                padding: 0 5px;
                font-weight: 900;
                font-size: 10px;
            }

            .footer {
                margin-top: 10px;
                display: flex;
                justify-content: space-between;
                align-items: flex-end;
                font-size: 10px;
                font-weight: bold;
                border-top: 1px dashed #ccc;
                padding-top: 5px;
            }

            .no-print {
                text-align: center;
                padding: 10px;
                background: #000;
                position: sticky;
                top: 0;
                z-index: 1000;
                display: flex;
                justify-content: center;
                gap: 10px;
                border-bottom: 1px solid #333;
            }
        </style>
    </head>
    <body>
        <div class="no-print">
            <button onclick="sendToPrinter()" style="padding: 8px 25px; font-size: 13px; font-weight: bold; background: #22c55e; color: #fff; border: none; cursor: pointer; border-radius: 4px;">PRINT MEASUREMENT SLIP</button>
            <button onclick="window.close()" style="padding: 8px 20px; font-size: 13px; font-weight: bold; background: #444; color: #fff; border: none; cursor: pointer; border-radius: 4px;">CLOSE</button>
        </div>
        <div id="print-area">
            <!-- ================= SHIRT PAGE ================= -->
            ${hasShirt ? `
            <div class="page">
                <header class="header-box">
                    <h1>CROMA TAILORS</h1>
                    <span class="label">SHIRT NOTES</span>
                </header>

                <div class="content">
                    <div class="top-section">
                        <div class="top-info">
                            <div class="info-item"><span class="info-label">ORDER NO.</span> <span class="info-value">#${customerInfo.bill_number}</span></div>
                            <div class="info-item"><span class="info-label">C. Name</span> <span class="info-value">${customerInfo.name}</span></div>
                            <div class="info-item"><span class="info-label">Contact No.</span> <span class="info-value">${customerInfo.phone || ""}</span></div>
                            <div class="info-item"><span class="info-label">Booking Date</span> <span class="info-value">${customerInfo.order_date}</span></div>
                            <div class="info-item"><span class="info-label">Delivery Date</span> <span class="info-value">${customerInfo.delivery_date}</span></div>
                        </div>

                        <div class="measurement-section">
                            <div class="col-left">
                                <div class="field-row"><span class="label-text">Height</span><div class="data-box">${data.length || ""}</div></div>
                                <div class="field-row"><span class="label-text">Chest</span><div class="m-boxes"><div class="data-box small">${data.chest || ""}</div><div class="data-box small">${data.chest_correct || ""}</div></div></div>
                                <div class="field-row"><span class="label-text">Hip Round</span><div class="m-boxes"><div class="data-box small">${data.hip || ""}</div><div class="data-box small">${data.hip_round || ""}</div></div></div>
                                <div class="field-row"><span class="label-text">Seat Round</span><div class="m-boxes"><div class="data-box small">${data.seat || ""}</div><div class="data-box small">${data.seat_round || ""}</div></div></div>
                                <div class="field-row"><span class="label-text">Shoulder</span><div class="data-box">${data.shoulder || ""}</div></div>
                                <div class="field-row"><span class="label-text">PattiStyle</span><div class="data-box wide">${data.front_patti_style || "Ordinary"}</div></div>
                            </div>
                            <div class="col-right">
                                <div class="field-row"><span class="label-text">S.Length</span><div class="data-box">${data.sleeve_height || ""}</div></div>
                                <div class="field-row"><span class="label-text">Bicep</span><div class="data-box">${data.bicep_round || ""}</div></div>
                                <div class="field-row"><span class="label-text">Cuff</span><div class="data-box">${data.cuff_round_finish || ""}</div></div>
                                <div class="field-row"><span class="label-text">Cuff Height</span><div class="data-box">${data.cuff_height || ""}</div></div>
                                <div class="field-row"><span class="label-text">Neck</span><div class="data-box">${data.neck || ""}</div></div>
                                <div class="field-row"><span class="label-text">B. Shape</span><div class="data-box wide">${data.apple_cut === 'YES' ? 'APPLE CUT' : 'NORMAL'}</div></div>
                            </div>
                        </div>

                        <div class="footer-notes">
                            <div class="footer-row">
                                <span class="footer-label">Comfort (6)</span>
                                <span class="footer-val">${data.fit_style || "Regular"}</span>
                            </div>
                            <div class="footer-row">
                                <span class="footer-label">Notes</span>
                                <span class="footer-val" style="flex: 1; border-bottom: 1px solid #ddd; padding-bottom: 2px;">${customerInfo.shirt_notes || ""}</span>
                            </div>
                        </div>
                    </div>

                    <div style="margin-top: 60px; display: flex; justify-content: flex-end; padding-top: 20px;">
                        <div style="text-align: center;">
                            <div style="width: 150px; border-top: 1px solid #000; margin-top: 40px; font-size: 10px; font-weight: bold;">TAILOR SIGNATURE</div>
                        </div>
                    </div>
                </div>
            </div>
            ` : ''}

            <!-- ================= PANT PAGE ================= -->
            ${hasPant ? `
            <div class="page">
                <header class="header-box">
                    <h1>CROMA TAILORS</h1>
                    <span class="label">PANT NOTES</span>
                </header>

                <div class="content">
                    <div class="top-section">
                        <div class="top-info">
                            <div class="info-item"><span class="info-label">ORDER NO.</span> <span class="info-value">#${customerInfo.bill_number}</span></div>
                            <div class="info-item"><span class="info-label">C. Name</span> <span class="info-value">${customerInfo.name}</span></div>
                            <div class="info-item"><span class="info-label">Contact No.</span> <span class="info-value">${customerInfo.phone || ""}</span></div>
                            <div class="info-item"><span class="info-label">Booking Date</span> <span class="info-value">${customerInfo.order_date}</span></div>
                            <div class="info-item"><span class="info-label">Delivery Date</span> <span class="info-value">${customerInfo.delivery_date}</span></div>
                        </div>

                        <div class="measurement-section">
                            <div class="col-left">
                                <div class="field-row"><span class="label-text">Height</span><div class="data-box">${data.height || ""}</div></div>
                                <div class="field-row"><span class="label-text">Waist</span><div class="data-box">${data.waist || ""}</div></div>
                                <div class="field-row"><span class="label-text">Seat</span><div class="data-box">${data.seat_pant || ""}</div></div>
                                <div class="field-row"><span class="label-text">Zip Length</span><div class="data-box">${data.zip_length || ""}</div></div>
                                <div class="field-row"><span class="label-text">In Seam</span><div class="data-box">${data.in_seam || ""}</div></div>
                                <div class="field-row"><span class="label-text">Pant Style</span><div class="data-box wide">${data.pant_type || ""}</div></div>
                            </div>
                            <div class="col-right">
                                <div class="field-row"><span class="label-text">Thigh</span><div class="data-box">${data.thigh || ""}</div></div>
                                <div class="field-row"><span class="label-text">Knee Loose</span><div class="data-box">${data.knee_loose || ""}</div></div>
                                <div class="field-row"><span class="label-text">Bottom Loose</span><div class="data-box">${data.bottom_loose || ""}</div></div>
                                <div class="field-row"><span class="label-text">B. Pocket</span><div class="data-box">${data.back_pocket || ""}</div></div>
                                <div class="field-row"><span class="label-text">Pocket</span><div class="data-box wide">${data.pocket_type || ""}</div></div>
                                <div class="field-row"><span class="label-text">Mobile Pkt</span><div class="data-box wide">${data.mobile_pocket || ""}</div></div>
                            </div>
                        </div>

                        <div class="footer-notes">
                            <div class="footer-row">
                                <span class="footer-label">Watch Pkt</span>
                                <span class="footer-val">${data.watch_pocket || ""}</span>
                            </div>
                            <div class="footer-row" style="margin-top: 5px;">
                                <span class="footer-label">Notes</span>
                                <span class="footer-val" style="flex: 1; border-bottom: 1px solid #ddd; padding-bottom: 2px;">${customerInfo.pant_notes || ""}</span>
                            </div>
                        </div>
                    </div>

                    <div style="margin-top: auto; display: flex; justify-content: flex-end; padding-top: 20px;">
                        <div style="text-align: center;">
                            <div style="width: 150px; border-top: 1px solid #000; margin-top: 40px; font-size: 10px; font-weight: bold;">TAILOR SIGNATURE</div>
                        </div>
                    </div>
                </div>
            </div>
            ` : ''}
        </div>
    </body>
    <script>
        const { ipcRenderer } = require('electron');
        function sendToPrinter() {
            ipcRenderer.send('trigger-final-print');
        }
    </script>
    </html>
    `;
    showStatus("Preparing measurement slip...", "⏳");
    // console.log("IPC PRINT TRIGGERED"); 
    ipcRenderer.invoke('print-html', htmlContent);
}

window.confirmSuccessPrint = confirmSuccessPrint;
window.closeSuccessModal = closeSuccessModal;
window.printOrderMeasurements = printOrderMeasurements;
window.printMeasurements = printMeasurements;
window.generateMeasurementSlip = generateMeasurementSlip;
window.showTab = showTab;
window.closeEditModal = closeEditModal;
window.toggleEditMeasurementType = toggleEditMeasurementType;
window.updateOrderFromModal = updateOrderFromModal;
window.loadTodayDeliveries = loadTodayDeliveries;

window.exportCSV = function(table) {
    db.all(`SELECT * FROM ${table}`, [], (err, rows) => {
        if (err || !rows || rows.length === 0) return showStatus("No data to export", "⚠️");

        const headers = Object.keys(rows[0]).join(",");
        const csv = [headers, ...rows.map(r => Object.values(r).map(v => `"${v}"`).join(","))].join("\n");

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);
        a.setAttribute('download', `${table}_export_${new Date().toISOString().slice(0, 10)}.csv`);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showStatus(`${table} exported!`, "✅");
    });
};
window.loadSearchDeliveries = loadSearchDeliveries;

function initSuccessModalListeners() {
    try {
        console.log("Initializing Success Modal Listeners...");
        const shirtBtn = document.getElementById('success-print-shirt');
        const pantBtn = document.getElementById('success-print-pant');
        const bothBtn = document.getElementById('success-print-both');
        const closeBtn = document.getElementById('success-close-btn');

        if (shirtBtn) {
            shirtBtn.onclick = () => { console.log("Shirt clicked"); window.printShirtOnly(); };
        }
        if (pantBtn) {
            pantBtn.onclick = () => { console.log("Pant clicked"); window.printPantOnly(); };
        }
        if (bothBtn) {
            bothBtn.onclick = () => { console.log("Both clicked"); window.printBothMeasurements(); };
        }
        if (closeBtn) {
            closeBtn.onclick = () => { console.log("Skip clicked"); window.closeSuccessModal(); };
        }
        console.log("Listeners Attached via onclick");
    } catch (e) {
        console.error("Listener attachment error:", e);
    }
}

setTimeout(initSuccessModalListeners, 1000); // Delay slightly to be sure

document.addEventListener('click', (e) => {
    console.log("Global Click at:", e.clientX, e.clientY, "Target:", e.target);
    // If target is locked, check its styles
    if (e.target && e.target.id) {
        const styles = window.getComputedStyle(e.target);
        console.log("Target ID:", e.target.id, "Z-Index:", styles.zIndex, "Pointer-Events:", styles.pointerEvents);
    }
}, true); // Use capture phase
// --- DAILY REMINDER AT 8 PM ---
let lastReminderDate = null;

function checkDailyReminder() {
    const now = new Date();
    const currentHour = now.getHours();
    const currentDate = now.toDateString();

    // Trigger at 8 PM (20:00) if not already shown today
    if (currentHour === 20 && lastReminderDate !== currentDate) {
        lastReminderDate = currentDate;
        showTomorrowReminders();
    }
}

function showTomorrowReminders() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    db.all(`
        SELECT DISTINCT c.name FROM orders o 
        JOIN customers c ON o.customer_id = c.id 
        WHERE o.delivery_date = ? AND (o.status IS NULL OR o.status != 'DELIVERED')
    `, [tomorrowStr], (err, rows) => {
        if (err || !rows || rows.length === 0) return;

        const listEl = document.getElementById('reminderCustomerList');
        if (!listEl) return;

        listEl.innerHTML = rows.map((r, index) => `
            <div style="display: flex; align-items: center; gap: 12px; padding: 10px 0; ${index < rows.length - 1 ? 'border-bottom: 1px solid #f1f5f9;' : ''}">
                <div style="width: 8px; height: 8px; background: #3b82f6; border-radius: 50%;"></div>
                <div style="font-weight: 700; color: #1e293b; font-size: 15px;">${r.name}</div>
            </div>
        `).join('');

        document.getElementById('reminderModal').classList.remove('hidden');
    });
}

// Check every minute
setInterval(checkDailyReminder, 60000);
// Also check on startup
setTimeout(checkDailyReminder, 5000);

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const { randomUUID } = require('crypto');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

/* ================= Global Crash Prevention ================= */
process.on('uncaughtException', (err) => {
    console.error('[ATSUGA] ⚠️  Unhandled Exception (server tetap berjalan):', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[ATSUGA] ⚠️  Unhandled Promise Rejection (server tetap berjalan):', reason?.message || reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ================= Paths ================= */
const SESSIONS_DIR = path.join(__dirname, 'whatsapp_sessions');
const INTEGRATIONS_FILE = path.join(__dirname, 'integrations.json');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/* ===============================================================
   INTEGRATIONS MANAGER
   Setiap integrasi = satu Apps Script + daftar trigger keywords
   Disimpan permanen ke integrations.json
   =============================================================== */

/**
 * Schema integrasi:
 * {
 *   id: string (uuid)
 *   sessionId: string        // ID sesi WA yang terhubung ke integrasi ini
 *   name: string
 *   description: string
 *   appsScriptUrl: string
 *   sheetName: string        // nama tab di spreadsheet
 *   triggers: string[]       // keyword awal pesan, kosong = catch-all
 *   matchMode: 'startsWith' | 'catchAll'
 *   autoSync: boolean
 *   enabled: boolean
 *   createdAt: ISO string
 *   lastSync: string | null
 *   lastTest: string | null
 * }
 */

function loadIntegrations() {
    try {
        if (fs.existsSync(INTEGRATIONS_FILE)) {
            const raw = fs.readFileSync(INTEGRATIONS_FILE, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error('[ATSUGA] Gagal membaca integrations.json:', e.message);
    }
    return [];
}

function saveIntegrations(list) {
    try {
        fs.writeFileSync(INTEGRATIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {
        console.error('[ATSUGA] Gagal menyimpan integrations.json:', e.message);
    }
}

// In-memory store (loaded from disk on startup)
let integrations = loadIntegrations();

console.log(`[ATSUGA] Loaded ${integrations.length} integration(s) from disk.`);

/**
 * Cari integrasi yang cocok untuk pesan masuk dari sesi tertentu.
 * Priority:
 *   1. Filter by sessionId → hanya integrasi milik sesi ini
 *   2. startsWith triggers → cek keyword awal pesan
 *   3. catchAll → fallback jika tidak ada trigger cocok
 */
function findMatchingIntegration(sessionId, messageBody) {
    const lower = messageBody.trim().toLowerCase();

    // Ambil semua integrasi milik session ini yang aktif
    const sessionIntegrations = integrations.filter(
        i => i.enabled && i.sessionId === sessionId
    );

    // 1. Cari berdasarkan startsWith triggers
    for (const intg of sessionIntegrations) {
        if (intg.matchMode === 'catchAll' || !intg.triggers || intg.triggers.length === 0) continue;
        const matched = intg.triggers.some(t => lower.startsWith(t.toLowerCase().trim()));
        if (matched) return intg;
    }

    // 2. Fallback: catch-all integration untuk session ini
    for (const intg of sessionIntegrations) {
        if (intg.matchMode === 'catchAll' || !intg.triggers || intg.triggers.length === 0) return intg;
    }

    // 3. Fallback global: integrasi tanpa sessionId (berlaku semua)
    const globalIntegrations = integrations.filter(
        i => i.enabled && !i.sessionId
    );
    for (const intg of globalIntegrations) {
        if (intg.matchMode === 'catchAll' || !intg.triggers || intg.triggers.length === 0) continue;
        const matched = intg.triggers.some(t => lower.startsWith(t.toLowerCase().trim()));
        if (matched) return intg;
    }
    for (const intg of globalIntegrations) {
        if (intg.matchMode === 'catchAll' || !intg.triggers || intg.triggers.length === 0) return intg;
    }

    return null;
}

/* ================= Active WA Sessions ================= */
const activeSessions = new Map();

/* ================= Default Reply ================= */
const DEFAULT_REPLY = '⚠️ Maaf, perintah tidak dikenal.\n\nKetik *help* untuk melihat daftar perintah yang tersedia.';

/* ===============================================================
   BAILEYS SESSION CONTROLLER
   =============================================================== */
async function startBaileysSession(sessionId, sessionName = 'WhatsApp Device') {
    if (activeSessions.has(sessionId)) {
        const existing = activeSessions.get(sessionId);
        if (['Connected', 'Scan QR', 'Connecting'].includes(existing.status)) return existing;
    }

    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    let version;
    try {
        const { version: v } = await fetchLatestBaileysVersion();
        version = v;
        console.log(`[ATSUGA WA] Using Baileys version: ${version.join('.')}`);
    } catch (e) {
        version = [2, 3000, 1015901307];
        console.log(`[ATSUGA WA] Using fallback Baileys version: ${version.join('.')}`);
    }

    const sessionData = {
        id: sessionId,
        name: sessionName,
        phone: 'Belum Terhubung',
        status: 'Connecting',
        qrRaw: null,
        qrDataUrl: null,
        sock: null,
        userJid: null,
        lastSeen: 'Just now'
    };
    activeSessions.set(sessionId, sessionData);

    try {
        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            browser: ['ATSUGA Gateway', 'Chrome', '130.0.6723.117'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            generateHighQualityLinkPreview: false
        });

        sessionData.sock = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    sessionData.qrRaw = qr;
                    sessionData.qrDataUrl = await QRCode.toDataURL(qr, {
                        errorCorrectionLevel: 'M',
                        type: 'image/png',
                        width: 300,
                        margin: 2,
                        color: { dark: '#000000', light: '#ffffff' }
                    });
                    sessionData.status = 'Scan QR';
                    console.log(`[ATSUGA WA] ✅ QR Ready: ${sessionId}`);
                } catch (err) {
                    console.error('[ATSUGA WA] Error generating QR:', err);
                }
            }

            if (connection === 'open') {
                sessionData.status = 'Connected';
                sessionData.qrRaw = null;
                sessionData.qrDataUrl = null;
                const jid = sock.user?.id || '';
                sessionData.phone = '+' + jid.split('@')[0].split(':')[0];
                sessionData.userJid = jid;
                console.log(`\n✅ [ATSUGA WA] Connected: ${sessionData.phone} (${sessionName})\n`);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[ATSUGA WA] Closed: ${sessionId}, code=${statusCode}, reconnect=${shouldReconnect}`);

                if (shouldReconnect) {
                    sessionData.status = 'Reconnecting';
                    sessionData.qrRaw = null;
                    sessionData.qrDataUrl = null;
                    activeSessions.delete(sessionId);
                    setTimeout(() => startBaileysSession(sessionId, sessionName), 3000);
                } else {
                    sessionData.status = 'Disconnected';
                    sessionData.qrRaw = null;
                    sessionData.qrDataUrl = null;
                    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) {}
                }
            }
        });

        /* =========================================================
           MESSAGE ROUTER — Inti ekosistem multi-integrasi
           ========================================================= */
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                if (msg.key.remoteJid === 'status@broadcast') continue;

                const from = msg.key.remoteJid;
                const body = (
                    msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
                    ''
                ).trim();

                if (!body) continue;

                console.log(`[ATSUGA ROUTER] 📩 Dari ${from}: "${body}"`);

                // Cari integrasi yang cocok (filter by sessionId dulu)
                const matched = findMatchingIntegration(sessionId, body);

                if (!matched) {
                    // Tidak ada integrasi yang cocok → kirim default reply
                    await sock.sendMessage(from, { text: DEFAULT_REPLY });
                    console.log(`[ATSUGA ROUTER] ℹ️  Tidak ada integrasi cocok → default reply`);
                    continue;
                }

                console.log(`[ATSUGA ROUTER] ✅ Match: "${matched.name}" → forward ke Apps Script`);

                try {
                    const response = await fetch(matched.appsScriptUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            session: sessionId,
                            from,
                            body
                        }),
                        signal: AbortSignal.timeout(20000)
                    });

                    const replyText = await response.text();

                    if (replyText && replyText.trim()) {
                        await sock.sendMessage(from, { text: replyText.trim() });
                        console.log(`[ATSUGA ROUTER] ✅ Balasan terkirim ke ${from} via "${matched.name}"`);
                        // Update lastSync timestamp
                        const midx = integrations.findIndex(i => i.id === matched.id);
                        if (midx !== -1) {
                            integrations[midx].lastSync = new Date().toISOString();
                            saveIntegrations(integrations);
                        }
                    }
                } catch (err) {
                    console.error(`[ATSUGA ROUTER] ❌ Error forward ke "${matched.name}": ${err.message}`);
                    await sock.sendMessage(from, {
                        text: `❌ Bot "${matched.name}" sedang tidak merespons. Coba lagi nanti.`
                    });
                }
            }
        });

    } catch (err) {
        console.error('[ATSUGA WA] Error starting Baileys socket:', err);
        sessionData.status = 'Error';
    }

    return sessionData;
}

/* ===============================================================
   REST API — STATUS & SESSIONS
   =============================================================== */

app.get('/api/status', (req, res) => {
    const list = Array.from(activeSessions.values()).map(s => ({
        id: s.id, name: s.name, phone: s.phone, status: s.status
    }));
    res.json({
        status: 'ONLINE',
        service: 'ATSUGA WhatsApp Gateway',
        version: '3.0.0',
        activeSessionsCount: list.length,
        sessions: list,
        integrationsCount: integrations.length,
        activeIntegrationsCount: integrations.filter(i => i.enabled).length
    });
});

app.post('/api/sessions/start', async (req, res) => {
    const { name } = req.body;
    const sessionId = 'session_' + Date.now();
    const sessionName = name || 'Device ' + (activeSessions.size + 1);

    startBaileysSession(sessionId, sessionName).catch(err => {
        console.error('[ATSUGA WA] Background session error:', err);
    });

    res.json({ success: true, sessionId, name: sessionName, status: 'Connecting', qrCodeDataUrl: null });
});

app.get('/api/sessions/:id/qr', (req, res) => {
    const session = activeSessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Sesi tidak ditemukan.' });
    res.json({
        success: true,
        sessionId: session.id,
        status: session.status,
        phone: session.phone,
        qrCodeDataUrl: session.qrDataUrl || null
    });
});

app.delete('/api/sessions/:id', async (req, res) => {
    const sessionId = req.params.id;
    const session = activeSessions.get(sessionId);
    if (session?.sock) { try { await session.sock.logout(); } catch (e) {} }
    activeSessions.delete(sessionId);
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) {}
    res.json({ success: true, message: `Sesi ${sessionId} berhasil dihapus.` });
});

app.post('/api/send-message', async (req, res) => {
    const { sessionId, to, message } = req.body;
    if (!to || !message) return res.status(400).json({ success: false, error: 'Parameter to dan message wajib diisi.' });

    let targetSession = sessionId && activeSessions.has(sessionId)
        ? activeSessions.get(sessionId)
        : [...activeSessions.values()].find(s => s.status === 'Connected' && s.sock);

    if (!targetSession?.sock || targetSession.status !== 'Connected') {
        return res.status(400).json({ success: false, error: 'Tidak ada perangkat WhatsApp yang terhubung.' });
    }

    let cleanPhone = to.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
    const jid = cleanPhone.includes('@s.whatsapp.net') ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;

    try {
        const result = await targetSession.sock.sendMessage(jid, { text: message });
        res.json({ success: true, messageId: result.key.id, to: cleanPhone, sentVia: targetSession.phone });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Gagal mengirim pesan: ' + err.message });
    }
});

/* ===============================================================
   REST API — INTEGRATIONS CRUD
   =============================================================== */

// GET all integrations (optional filter by ?sessionId=xxx)
app.get('/api/integrations', (req, res) => {
    const { sessionId } = req.query;
    const result = sessionId
        ? integrations.filter(i => i.sessionId === sessionId)
        : integrations;
    res.json({ success: true, count: result.length, integrations: result });
});

// POST create new integration
app.post('/api/integrations', (req, res) => {
    const { sessionId, name, description, appsScriptUrl, sheetName, triggers, matchMode, autoSync, enabled } = req.body;

    if (!name || !appsScriptUrl) {
        return res.status(400).json({ success: false, error: 'name dan appsScriptUrl wajib diisi.' });
    }

    const newIntegration = {
        id: randomUUID(),
        sessionId: sessionId || null,
        name: name.trim(),
        description: (description || '').trim(),
        appsScriptUrl: appsScriptUrl.trim(),
        sheetName: (sheetName || 'Transaksi').trim(),
        triggers: Array.isArray(triggers) ? triggers.map(t => t.trim()).filter(Boolean) : [],
        matchMode: matchMode === 'catchAll' ? 'catchAll' : 'startsWith',
        autoSync: autoSync !== false,
        enabled: enabled !== false,
        createdAt: new Date().toISOString(),
        lastSync: null,
        lastTest: null
    };

    integrations.push(newIntegration);
    saveIntegrations(integrations);

    console.log(`[ATSUGA] ✅ Integrasi baru: "${newIntegration.name}" (session: ${sessionId || 'global'}, triggers: ${newIntegration.triggers.join(', ') || 'catch-all'})`);
    res.json({ success: true, integration: newIntegration });
});

// PUT update integration
app.put('/api/integrations/:id', (req, res) => {
    const idx = integrations.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Integrasi tidak ditemukan.' });

    const { name, description, appsScriptUrl, sheetName, triggers, matchMode, autoSync, enabled } = req.body;
    const intg = integrations[idx];

    if (name !== undefined) intg.name = name.trim();
    if (description !== undefined) intg.description = description.trim();
    if (appsScriptUrl !== undefined) intg.appsScriptUrl = appsScriptUrl.trim();
    if (sheetName !== undefined) intg.sheetName = sheetName.trim();
    if (triggers !== undefined) intg.triggers = Array.isArray(triggers) ? triggers.map(t => t.trim()).filter(Boolean) : [];
    if (matchMode !== undefined) intg.matchMode = matchMode === 'catchAll' ? 'catchAll' : 'startsWith';
    if (autoSync !== undefined) intg.autoSync = Boolean(autoSync);
    if (enabled !== undefined) intg.enabled = Boolean(enabled);
    intg.updatedAt = new Date().toISOString();

    integrations[idx] = intg;
    saveIntegrations(integrations);

    console.log(`[ATSUGA] ✏️  Integrasi diupdate: "${intg.name}"`);
    res.json({ success: true, integration: intg });
});

// DELETE integration
app.delete('/api/integrations/:id', (req, res) => {
    const idx = integrations.findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Integrasi tidak ditemukan.' });

    const removed = integrations.splice(idx, 1)[0];
    saveIntegrations(integrations);

    console.log(`[ATSUGA] 🗑️  Integrasi dihapus: "${removed.name}"`);
    res.json({ success: true, message: `Integrasi "${removed.name}" berhasil dihapus.` });
});

// POST test integration (kirim "help" ke Apps Script)
app.post('/api/integrations/:id/test', async (req, res) => {
    const intg = integrations.find(i => i.id === req.params.id);
    if (!intg) return res.status(404).json({ success: false, error: 'Integrasi tidak ditemukan.' });

    if (!intg.appsScriptUrl) {
        return res.status(400).json({ success: false, error: 'Apps Script URL belum dikonfigurasi.' });
    }

    try {
        const testPayload = { session: 'test', from: 'test@s.whatsapp.net', body: 'help' };
        const response = await fetch(intg.appsScriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testPayload),
            signal: AbortSignal.timeout(15000)
        });
        const text = await response.text();

        // Update lastTest timestamp
        const idx = integrations.findIndex(i => i.id === intg.id);
        if (idx !== -1) {
            integrations[idx].lastTest = new Date().toISOString();
            saveIntegrations(integrations);
        }

        res.json({ success: true, status: response.status, response: text.substring(0, 800) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ===============================================================
   FALLBACK SPA
   =============================================================== */
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(` 🚀 ATSUGA WhatsApp Gateway v3.0 Running!`);
    console.log(` 🌐 Dashboard: http://localhost:${PORT}`);
    console.log(` ⚡ API:       http://localhost:${PORT}/api/status`);
    console.log(` 🔗 Integrations loaded: ${integrations.length}`);
    console.log(`==================================================\n`);
});

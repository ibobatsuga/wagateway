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
const PLUGINS_FILE = path.join(__dirname, 'plugins.json');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/* ===============================================================
   PLUGINS MANAGER (OpenWA-inspired Modular Architecture)
   =============================================================== */

const DEFAULT_PLUGINS = [
    {
        id: 'google-sheets',
        name: 'Google Sheets Sync',
        description: 'Otomatiskan logging pesan WA & Keuangan Bot ke Google Spreadsheet',
        category: 'database',
        icon: 'ph-table',
        enabled: true,
        config: {}
    },
    {
        id: 'n8n-webhook',
        name: 'n8n Automation & Webhook (OpenWA Specs)',
        description: 'Forward pesan WhatsApp ke n8n / Make.com dengan skema JSON OpenWA',
        category: 'automation',
        icon: 'ph-lightning',
        enabled: false,
        config: {
            webhookUrl: '',
            secretKey: '',
            events: ['message.received']
        }
    },
    {
        id: 'ai-agent',
        name: 'AI CS Agent (Groq / OpenAI)',
        description: 'Auto-responder cerdas berbasis LLM AI (Groq Llama-3 / GPT-4o)',
        category: 'ai',
        icon: 'ph-robot',
        enabled: false,
        config: {
            provider: 'groq',
            apiKey: '',
            model: 'llama-3.3-70b-versatile',
            systemPrompt: 'Kamu adalah ATSUGA Bot, asisten layanan pelanggan yang sangat ramah, profesional, dan cepat tanggap. Selalu jawab dalam Bahasa Indonesia.'
        }
    },
    {
        id: 'media-dispatcher',
        name: 'Rich Media & Document Dispatcher',
        description: 'Kirim gambar, dokumen PDF, nota, dan voice note via WhatsApp API',
        category: 'media',
        icon: 'ph-image',
        enabled: true,
        config: {}
    }
];

function loadPlugins() {
    try {
        if (fs.existsSync(PLUGINS_FILE)) {
            const raw = fs.readFileSync(PLUGINS_FILE, 'utf8');
            const saved = JSON.parse(raw);
            // Merge defaults with saved config to preserve new keys
            return DEFAULT_PLUGINS.map(dp => {
                const sp = saved.find(s => s.id === dp.id);
                return sp ? { ...dp, ...sp, config: { ...dp.config, ...sp.config } } : dp;
            });
        }
    } catch (e) {
        console.error('[ATSUGA PLUGINS] Error loading plugins.json:', e.message);
    }
    return DEFAULT_PLUGINS;
}

function savePlugins(list) {
    try {
        fs.writeFileSync(PLUGINS_FILE, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {
        console.error('[ATSUGA PLUGINS] Error saving plugins.json:', e.message);
    }
}

let plugins = loadPlugins();
console.log(`[ATSUGA PLUGINS] ${plugins.length} plugin(s) loaded. Active: ${plugins.filter(p => p.enabled).map(p => p.id).join(', ')}`);

/* ===============================================================
   INTEGRATIONS MANAGER
   Setiap integrasi = satu Apps Script + daftar trigger keywords
   Disimpan permanen ke integrations.json
   =============================================================== */

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

let integrations = loadIntegrations();
console.log(`[ATSUGA] Loaded ${integrations.length} integration(s) from disk.`);

function findMatchingIntegration(sessionId, messageBody) {
    const lower = messageBody.trim().toLowerCase();

    const sessionIntegrations = integrations.filter(
        i => i.enabled && i.sessionId === sessionId
    );

    for (const intg of sessionIntegrations) {
        if (intg.matchMode === 'catchAll' || !intg.triggers || intg.triggers.length === 0) continue;
        const matched = intg.triggers.some(t => lower.startsWith(t.toLowerCase().trim()));
        if (matched) return intg;
    }

    for (const intg of sessionIntegrations) {
        if (intg.matchMode === 'catchAll' || !intg.triggers || intg.triggers.length === 0) return intg;
    }

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
           MESSAGE ROUTER — OpenWA Plugin Pipeline
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

                // 1. PLUGIN: n8n & Universal Webhook (OpenWA Payload Spec)
                const n8nPlugin = plugins.find(p => p.id === 'n8n-webhook');
                if (n8nPlugin?.enabled && n8nPlugin.config?.webhookUrl) {
                    try {
                        const openWaPayload = {
                            event: 'message.received',
                            session: sessionId,
                            senderPhone: sessionData.phone,
                            from,
                            messageId: msg.key.id,
                            body,
                            timestamp: Date.now()
                        };
                        fetch(n8nPlugin.config.webhookUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                ...(n8nPlugin.config.secretKey ? { 'X-OpenWA-Secret': n8nPlugin.config.secretKey } : {})
                            },
                            body: JSON.stringify(openWaPayload)
                        }).catch(e => console.error('[n8n Webhook Error]:', e.message));
                        console.log(`[ATSUGA ROUTER] ⚡ Forwarded to n8n OpenWA Webhook`);
                    } catch (e) {}
                }

                // 2. PLUGIN: Google Sheets Sync (Keuangan Bot & Lead Sync)
                const sheetsPlugin = plugins.find(p => p.id === 'google-sheets');
                if (sheetsPlugin?.enabled) {
                    const matched = findMatchingIntegration(sessionId, body);

                    if (matched) {
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
                                const midx = integrations.findIndex(i => i.id === matched.id);
                                if (midx !== -1) {
                                    integrations[midx].lastSync = new Date().toISOString();
                                    saveIntegrations(integrations);
                                }
                            }
                            continue; // Process next message if handled
                        } catch (err) {
                            console.error(`[ATSUGA ROUTER] ❌ Error forward ke "${matched.name}": ${err.message}`);
                        }
                    }
                }

                // 3. PLUGIN: AI CS Agent (Groq / OpenAI Auto-Responder)
                const aiPlugin = plugins.find(p => p.id === 'ai-agent');
                if (aiPlugin?.enabled && aiPlugin.config?.apiKey) {
                    try {
                        console.log(`[ATSUGA ROUTER] 🤖 Forwarding to AI Agent (${aiPlugin.config.provider})...`);
                        const isGroq = aiPlugin.config.provider === 'groq';
                        const aiEndpoint = isGroq
                            ? 'https://api.groq.com/openai/v1/chat/completions'
                            : 'https://api.openai.com/v1/chat/completions';

                        const aiRes = await fetch(aiEndpoint, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${aiPlugin.config.apiKey}`
                            },
                            body: JSON.stringify({
                                model: aiPlugin.config.model || (isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o'),
                                messages: [
                                    { role: 'system', content: aiPlugin.config.systemPrompt },
                                    { role: 'user', content: body }
                                ],
                                temperature: 0.7
                            }),
                            signal: AbortSignal.timeout(15000)
                        });

                        const aiJson = await aiRes.json();
                        const aiReply = aiJson.choices?.[0]?.message?.content;
                        if (aiReply && aiReply.trim()) {
                            await sock.sendMessage(from, { text: aiReply.trim() });
                            console.log(`[ATSUGA ROUTER] 🤖 AI Agent responded to ${from}`);
                            continue;
                        }
                    } catch (e) {
                        console.error('[AI Agent Error]:', e.message);
                    }
                }

                // Fallback default reply
                await sock.sendMessage(from, { text: DEFAULT_REPLY });
                console.log(`[ATSUGA ROUTER] ℹ️  Default reply sent`);
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
   REST API — PLUGINS CRUD & MEDIA DISPATCHER
   =============================================================== */

// GET all plugins
app.get('/api/plugins', (req, res) => {
    res.json({ success: true, count: plugins.length, plugins });
});

// PUT update plugin
app.put('/api/plugins/:id', (req, res) => {
    const idx = plugins.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Plugin tidak ditemukan.' });

    const { enabled, config } = req.body;
    if (enabled !== undefined) plugins[idx].enabled = Boolean(enabled);
    if (config !== undefined) plugins[idx].config = { ...plugins[idx].config, ...config };

    savePlugins(plugins);
    console.log(`[ATSUGA PLUGINS] ✏️ Plugin "${plugins[idx].id}" updated. Enabled: ${plugins[idx].enabled}`);
    res.json({ success: true, plugin: plugins[idx] });
});

// POST test plugin connection
app.post('/api/plugins/:id/test', async (req, res) => {
    const plugin = plugins.find(p => p.id === req.params.id);
    if (!plugin) return res.status(404).json({ success: false, error: 'Plugin tidak ditemukan.' });

    if (plugin.id === 'n8n-webhook') {
        if (!plugin.config?.webhookUrl) {
            return res.status(400).json({ success: false, error: 'Webhook URL belum diisi.' });
        }
        try {
            const testPayload = {
                event: 'test.connection',
                session: 'test_session',
                senderPhone: '+6280000000',
                from: '6280000000@s.whatsapp.net',
                messageId: 'TEST_' + Date.now(),
                body: 'Halo n8n! Test integrasi OpenWA ATSUGA.',
                timestamp: Date.now()
            };
            const r = await fetch(plugin.config.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(testPayload),
                signal: AbortSignal.timeout(10000)
            });
            const txt = await r.text();
            res.json({ success: true, status: r.status, response: txt.substring(0, 500) });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    } else if (plugin.id === 'ai-agent') {
        if (!plugin.config?.apiKey) {
            return res.status(400).json({ success: false, error: 'API Key AI Agent belum diisi.' });
        }
        try {
            const isGroq = plugin.config.provider === 'groq';
            const endpoint = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
            const r = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${plugin.config.apiKey}` },
                body: JSON.stringify({
                    model: plugin.config.model || (isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o'),
                    messages: [{ role: 'user', content: 'Ping' }],
                    max_tokens: 10
                }),
                signal: AbortSignal.timeout(10000)
            });
            const j = await r.json();
            res.json({ success: true, response: j.choices?.[0]?.message?.content || 'OK' });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    } else {
        res.json({ success: true, message: `Plugin ${plugin.name} aktif & siap digunakan.` });
    }
});

// POST send media (Images, PDFs, Documents) via Baileys API
app.post('/api/send-media', async (req, res) => {
    const { sessionId, to, type, mediaUrl, caption, fileName } = req.body;
    if (!to || !mediaUrl) {
        return res.status(400).json({ success: false, error: 'Parameter to dan mediaUrl wajib diisi.' });
    }

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
        let msgContent = {};
        if (type === 'document' || type === 'pdf') {
            msgContent = {
                document: { url: mediaUrl },
                mimetype: 'application/pdf',
                fileName: fileName || 'document.pdf',
                caption: caption || ''
            };
        } else {
            msgContent = {
                image: { url: mediaUrl },
                caption: caption || ''
            };
        }

        const result = await targetSession.sock.sendMessage(jid, msgContent);
        res.json({ success: true, messageId: result.key.id, to: cleanPhone, sentVia: targetSession.phone });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Gagal mengirim media: ' + err.message });
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

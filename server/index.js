const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const httpServer = createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const io = new Server(httpServer, {
  cors: { origin: FRONTEND_URL, methods: ['GET', 'POST'] }
});

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
fs.ensureDirSync(DOWNLOADS_DIR);

// ─── Stream download intercept ────────────────────────────────────────────────
// Puppeteer captures all WA Web downloads here; we serve them back to the
// browser via a short-lived one-time token so the user actually gets the file.
const STREAM_DL_DIR = path.join(__dirname, '..', 'stream_downloads');
fs.ensureDirSync(STREAM_DL_DIR);

const pendingDownloads = new Map(); // token -> { filename, expires }

// Clean up expired tokens every minute
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pendingDownloads) {
    if (entry.expires < now) pendingDownloads.delete(token);
  }
}, 60_000);

// Poll for new files in STREAM_DL_DIR and notify connected stream viewers
let knownDlFiles = new Set(fs.readdirSync(STREAM_DL_DIR));
setInterval(() => {
  try {
    const current = fs.readdirSync(STREAM_DL_DIR);
    for (const f of current) {
      if (knownDlFiles.has(f)) continue;
      knownDlFiles.add(f);
      const filePath = path.join(STREAM_DL_DIR, f);
      // Wait 1 s to ensure the file is fully written before serving
      setTimeout(() => {
        try {
          if (!fs.existsSync(filePath)) return;
          const { size } = fs.statSync(filePath);
          if (size === 0) return;
          const token = crypto.randomBytes(16).toString('hex');
          pendingDownloads.set(token, { filename: f, expires: Date.now() + 120_000 });
          console.log(`[DL] New download ready: ${f} (${size} bytes)`);
          streamViewers.forEach(s => s.emit('wa_download_ready', {
            filename: f,
            size,
            url: `/api/stream/download/${token}`,
          }));
        } catch (_) {}
      }, 1000);
    }
    knownDlFiles = new Set(current);
  } catch (_) {}
}, 1000);

// ─── Config ───────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_TOKEN = Buffer.from(ADMIN_PASSWORD).toString('base64');

// ─── WhatsApp client ──────────────────────────────────────────────────────────
let client = null;
let clientStatus = 'initializing';
let currentQR = null;
let cachedStatuses = [];
const mediaCache = new Map(); // msgId -> { mediaKey, directPath, mediaUrl, filehash, mediaKeyTimestamp, mimetype, type }

function initClient() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', '.wwebjs_auth') }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        // Required for running as root in a container (Render)
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Use /tmp instead of /dev/shm which is tiny on Render free tier
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-zygote',
        // Single process avoids spawning a separate renderer — critical on 512 MB
        '--single-process',
        // GPU / graphics — all disabled for a headless server
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--disable-accelerated-video-decode',
        // Reduce memory footprint
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--safebrowsing-disable-auto-update',
        // Allow autoplay so WA Web can load media without user gesture
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-media-suspend',
      ]
    }
  });

  client.on('qr', async (qr) => {
    clientStatus = 'qr';
    currentQR = await qrcode.toDataURL(qr);
    io.emit('qr', { qr: currentQR });
    console.log('[WA] QR code generated');
  });

  client.on('loading_screen', (percent) => {
    clientStatus = 'loading';
    io.emit('loading', { percent });
  });

  client.on('authenticated', () => {
    clientStatus = 'loading';
    currentQR = null;
    io.emit('authenticated');
    console.log('[WA] Authenticated');
  });

  client.on('ready', async () => {
    clientStatus = 'ready';
    io.emit('ready');
    console.log('[WA] Client ready — fetching statuses in 5s…');

    // Inject a MutationObserver that watches for WA's video error message and
    // automatically clicks the download button. Since headless Chrome can't
    // decode H.264 for playback, this makes media silently download instead.
    try {
      await client.pupPage.evaluate(() => {
        const clickDownload = () => {
          const sels = [
            '[data-icon="download"]',
            '[data-testid="media-download"]',
            'button[aria-label*="Download"]',
            '[title*="Download"]',
            'span[data-icon="download"]',
          ];
          for (const sel of sels) {
            for (const el of document.querySelectorAll(sel)) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                (el.closest('button,[role="button"]') || el).click();
                return true;
              }
            }
          }
          return false;
        };

        new MutationObserver(() => {
          // WA Web video error text (English + common variants)
          const body = document.body.innerText || '';
          if (/trouble playing|cannot play|video error|playback error/i.test(body)) {
            clickDownload();
          }
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      console.log('[WA] Auto-download on video error injected');
    } catch (e) {
      console.warn('[WA] Could not inject auto-download helper:', e.message);
    }

    // Configure puppeteer to redirect all downloads (images, videos, docs) to
    // STREAM_DL_DIR instead of the system default. We then serve them back to
    // the browser via the /api/stream/download/:token endpoint.
    // NOTE: Must use Page.setDownloadBehavior on a PAGE-level CDP session.
    //       Browser.setDownloadBehavior requires a browser-level session and
    //       fails silently when called on a page session.
    try {
      const cdp = await client.pupPage.createCDPSession();
      await cdp.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: STREAM_DL_DIR,
      });
      console.log('[WA] Download intercept configured');
    } catch (e) {
      console.warn('[WA] Could not configure download intercept:', e.message);
    }

    // Give WA Web time to finish rendering before we poke the status tab
    setTimeout(async () => {
      cachedStatuses = await fetchStatuses();
      console.log(`[WA] Found ${cachedStatuses.length} contacts with statuses`);
      io.emit('statuses_updated', cachedStatuses);
    }, 5000);
  });

  // Capture live incoming messages
  client.on('message', (msg) => {
    if (msg.isStatus) {
      console.log('[WA] New status from:', msg.from);
      fetchStatuses().then(list => {
        cachedStatuses = list;
        io.emit('statuses_updated', cachedStatuses);
      });
    } else {
      // Broadcast to all connected UI clients for real-time chat updates
      io.emit('chat_message', {
        chatId: msg.from,
        id: msg.id._serialized,
        body: msg.body,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        type: msg.type,
      });
    }
  });

  client.on('disconnected', async (reason) => {
    clientStatus = 'disconnected';
    currentQR = null;
    io.emit('disconnected', { reason });
    console.log('[WA] Disconnected:', reason);

    // Destroy the old Chromium process before creating a new one.
    // Without this, reinitialising on Render's free tier (512 MB) spawns a
    // second browser that immediately OOMs and crashes both instances.
    try {
      await client.destroy();
    } catch (_) {}

    // LOGOUT means the user signed out from their phone — show fresh QR.
    // For everything else (network blips, Render restarts, conflicts) reconnect.
    if (reason !== 'LOGOUT') {
      console.log('[WA] Non-logout disconnect — reinitialising in 5s…');
      setTimeout(() => initClient(), 5000);
    } else {
      // Even on logout we reinitialise so the QR screen appears automatically.
      console.log('[WA] Logout — showing fresh QR in 5s…');
      setTimeout(() => initClient(), 5000);
    }
  });

  client.initialize().catch(async err => {
    console.error('[WA] Init error:', err);
    clientStatus = 'disconnected';
    io.emit('disconnected', { reason: err.message });
    try { await client.destroy(); } catch (_) {}
    console.log('[WA] Init failed — retrying in 10s…');
    setTimeout(() => initClient(), 10000);
  });
}

// ─── Navigate the headless browser to the Status tab ─────────────────────────
async function triggerStatusLoad() {
  try {
    const clicked = await client.pupPage.evaluate(() => {
      // WhatsApp Web status tab selectors (try several — WA changes these)
      const selectors = [
        '[data-icon="status-v3"]',
        '[data-testid="status-v3-btn"]',
        'span[data-icon="status"]',
        '[aria-label="Status"]',
        '[title="Status"]',
        '[data-icon="stories"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          el.closest('button, div[role="button"], [tabindex]')?.click() ?? el.click();
          return sel;
        }
      }
      return null;
    });
    if (clicked) {
      console.log('[WA] Clicked status tab:', clicked);
    } else {
      console.log('[WA] Could not find status tab — reading store directly');
    }
    // Wait for data to populate
    await new Promise(r => setTimeout(r, 3000));
  } catch (e) {
    console.log('[WA] triggerStatusLoad error:', e.message);
  }
}

// ─── Status fetcher ───────────────────────────────────────────────────────────
async function fetchStatuses() {
  if (!client || clientStatus !== 'ready') return [];

  // Navigate to the Status section first so WA populates the store
  await triggerStatusLoad();

  try {
    const result = await client.pupPage.evaluate(() => {
      const debug = {};

      // 1. Log which status-related stores exist
      const storeKeys = Object.keys(window.Store || {});
      debug.statusRelatedKeys = storeKeys.filter(k => /status/i.test(k));

      // 2. Try known store candidates
      const candidates = ['StatusV3', 'Status', 'StatusRecent', 'StatusV2'];
      for (const name of candidates) {
        const store = window.Store[name];
        if (!store) { debug[name] = 'missing'; continue; }

        let models = [];
        try {
          if (typeof store.getModelsArray === 'function') models = store.getModelsArray();
          else if (typeof store.getAll === 'function') models = store.getAll();
          else if (Array.isArray(store.models)) models = store.models;
        } catch (e) {
          debug[name] = 'error: ' + e.message;
          continue;
        }

        debug[name] = `${models.length} entries`;

        if (models.length > 0) {
          const statuses = models.map(s => {
            let msgs = [];
            try {
              msgs = s.msgs
                ? (typeof s.msgs.getModelsArray === 'function' ? s.msgs.getModelsArray() : [])
                : [];
            } catch (_) {}
            const ct = s.id ? (window.Store.Contact?.get(s.id._serialized) || window.Store.Contact?.get(s.id.user + '@c.us')) : null;
            return {
              id: s.id ? s.id._serialized : String(Date.now() + Math.random()),
              contactName: ct?.name || ct?.pushname || ct?.shortName || s.name || s.formattedTitle || (s.id ? s.id.user : ''),
              phone: s.id ? s.id.user : '',
              updates: msgs.map(m => ({
                id: m.id ? m.id._serialized : String(Math.random()),
                type: m.type || 'unknown',
                body: m.body || '',
                caption: m.caption || '',
                timestamp: m.t || 0,
                viewed: m.viewed || false,
                mimetype: m.mimetype || null,
                _directPath: m.directPath || null,
                _mediaUrl: m.mediaUrl || null,
                _mediaKey: m.mediaKey
                  ? (typeof m.mediaKey === 'string'
                    ? m.mediaKey
                    : (m.mediaKey?.length ? btoa(String.fromCharCode(...new Uint8Array(m.mediaKey))) : null))
                  : null,
                _filehash: m.filehash || null,
                _mediaKeyTimestamp: m.mediaKeyTimestamp ?? m.t ?? null,
              }))
            };
          }).filter(s => s.updates.length > 0);

          return { debug, statuses, usedStore: name };
        }
      }

      // 3. Fallback: scan all Chat models for status chats
      try {
        const chats = window.Store.Chat
          ? (window.Store.Chat.getModelsArray ? window.Store.Chat.getModelsArray() : [])
          : [];
        const statusChats = chats.filter(c => c.isStatusV3 || c.kind === 'status');
        debug.chatFallback = `${statusChats.length} status chats`;

        if (statusChats.length > 0) {
          const statuses = statusChats.map(s => {
            let msgs = [];
            try {
              msgs = s.msgs
                ? (typeof s.msgs.getModelsArray === 'function' ? s.msgs.getModelsArray() : [])
                : [];
            } catch (_) {}
            const ct2 = s.id ? (window.Store.Contact?.get(s.id._serialized) || window.Store.Contact?.get(s.id.user + '@c.us')) : null;
            return {
              id: s.id ? s.id._serialized : String(Date.now()),
              contactName: ct2?.name || ct2?.pushname || ct2?.shortName || s.name || s.formattedTitle || (s.id ? s.id.user : ''),
              phone: s.id ? s.id.user : '',
              updates: msgs.map(m => ({
                id: m.id ? m.id._serialized : String(Math.random()),
                type: m.type || 'unknown',
                body: m.body || '',
                caption: m.caption || '',
                timestamp: m.t || 0,
                viewed: m.viewed || false,
                mimetype: m.mimetype || null,
                _directPath: m.directPath || null,
                _mediaUrl: m.mediaUrl || null,
                _mediaKey: m.mediaKey
                  ? (typeof m.mediaKey === 'string'
                    ? m.mediaKey
                    : (m.mediaKey?.length ? btoa(String.fromCharCode(...new Uint8Array(m.mediaKey))) : null))
                  : null,
                _filehash: m.filehash || null,
                _mediaKeyTimestamp: m.mediaKeyTimestamp ?? m.t ?? null,
              }))
            };
          }).filter(s => s.updates.length > 0);
          return { debug, statuses, usedStore: 'Chat(statusV3)' };
        }
      } catch (e) {
        debug.chatFallbackErr = e.message;
      }

      return { debug, statuses: [], usedStore: null };
    });

    console.log('[WA] Store debug:', JSON.stringify(result.debug));
    console.log(`[WA] Used store: ${result.usedStore} | Contacts: ${result.statuses.length}`);

    const statuses = result.statuses || [];
    // Cache media metadata keyed by message ID for reliable download later
    for (const contact of statuses) {
      for (const update of contact.updates) {
        if (update._directPath || update._mediaKey) {
          mediaCache.set(update.id, {
            directPath: update._directPath,
            mediaUrl: update._mediaUrl,
            mediaKey: update._mediaKey,
            filehash: update._filehash,
            mediaKeyTimestamp: update._mediaKeyTimestamp,
            mimetype: update.mimetype,
            type: update.type,
          });
        }
        delete update._directPath;
        delete update._mediaUrl;
        delete update._mediaKey;
        delete update._filehash;
        delete update._mediaKeyTimestamp;
      }
    }
    return statuses;
  } catch (err) {
    console.error('[WA] fetchStatuses error:', err.message);
    return [];
  }
}

// ─── REST endpoints ───────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ status: clientStatus, qr: currentQR });
});

app.get('/api/statuses', async (req, res) => {
  if (clientStatus !== 'ready') return res.json([]);
  cachedStatuses = await fetchStatuses();
  res.json(cachedStatuses);
});

// Debug: inspect what's in the WA browser store
app.get('/api/debug/stores', async (req, res) => {
  if (!client || clientStatus !== 'ready') return res.status(503).json({ error: 'not ready' });
  try {
    const info = await client.pupPage.evaluate(() => {
      const keys = Object.keys(window.Store || {});
      const statusKeys = keys.filter(k => /status|story|stories/i.test(k));
      const result = { allStoreCount: keys.length, statusRelated: statusKeys };
      for (const k of statusKeys) {
        try {
          const s = window.Store[k];
          const models = s.getModelsArray ? s.getModelsArray() : (s.models || []);
          result[k] = models.length + ' models';
        } catch (e) {
          result[k] = 'error: ' + e.message;
        }
      }
      return result;
    });
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/download/:msgId', async (req, res) => {
  const msgId = decodeURIComponent(req.params.msgId);
  if (!client || clientStatus !== 'ready') {
    return res.status(503).json({ error: 'Client not ready' });
  }
  try {
    // Re-navigate to the Status tab so the store is populated before we search
    await triggerStatusLoad();

    // Use cached metadata from fetch time as primary fallback when the store is empty
    const cachedMeta = mediaCache.get(msgId) || null;

    // Status messages live in StatusV3, not the normal Msg store.
    // getMessageById won't find them — we look them up via pupPage directly.
    const result = await client.pupPage.evaluate(async (targetId, cachedMeta) => {
      // ── Helpers ────────────────────────────────────────────────────────────
      async function bufToBase64(buf) {
        const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer ?? buf);
        let binary = '';
        const CHUNK = 8192;
        for (let i = 0; i < bytes.byteLength; i += CHUNK)
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        return btoa(binary);
      }

      function b64ToBytes(b64) {
        return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      }

      // Manual decryption using Web Crypto (last-resort, no WA internals needed)
      async function decryptMedia(mediaKeyB64, encryptedBuf, mediaType) {
        const appInfoMap = {
          image: 'WhatsApp Image Keys', video: 'WhatsApp Video Keys',
          audio: 'WhatsApp Audio Keys', document: 'WhatsApp Document Keys',
          sticker: 'WhatsApp Image Keys',
        };
        const appInfo = new TextEncoder().encode(appInfoMap[mediaType] || 'WhatsApp Image Keys');
        const keyBytes = b64ToBytes(mediaKeyB64);
        const km = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveBits']);
        const derived = new Uint8Array(await crypto.subtle.deriveBits(
          { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: appInfo },
          km, 112 * 8
        ));
        const iv = derived.slice(0, 16);
        const cipherKey = await crypto.subtle.importKey('raw', derived.slice(16, 48), { name: 'AES-CBC' }, false, ['decrypt']);
        // strip last 10 bytes (HMAC tag)
        const cipherText = encryptedBuf.slice(0, encryptedBuf.byteLength - 10);
        return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cipherKey, cipherText);
      }

      // Try every download-shaped function on DownloadManager
      async function tryDownloadManager(msgObj, meta) {
        const dm = window.Store.DownloadManager;
        if (!dm) return null;
        const fnNames = Object.getOwnPropertyNames(dm)
          .filter(k => typeof dm[k] === 'function' && /download/i.test(k));
        for (const fn of fnNames) {
          try {
            const r = await dm[fn](
              msgObj,
              meta.mediaKey, meta.mediaKeyTimestamp,
              meta.directPath, meta.mediaUrl,
              meta.type, meta.filehash
            );
            if (r) return r;
          } catch (_) {}
          // Some versions take only the msg object
          try {
            const r = await dm[fn](msgObj);
            if (r) return r;
          } catch (_) {}
        }
        return null;
      }

      // Find message in status stores
      function findInStatusStores(id) {
        const candidates = ['StatusV3', 'Status', 'StatusRecent', 'StatusV2'];
        for (const name of candidates) {
          const store = window.Store[name];
          if (!store) continue;
          let contacts = [];
          try { contacts = store.getModelsArray ? store.getModelsArray() : (store.models || []); } catch (_) { continue; }
          for (const contact of contacts) {
            let msgs = [];
            try { msgs = contact.msgs?.getModelsArray ? contact.msgs.getModelsArray() : []; } catch (_) {}
            const found = msgs.find(m => m.id?._serialized === id);
            if (found) return found;
          }
        }
        try {
          const chats = window.Store.Chat?.getModelsArray?.() || [];
          for (const chat of chats.filter(c => c.isStatusV3 || c.kind === 'status')) {
            let msgs = [];
            try { msgs = chat.msgs?.getModelsArray?.() || []; } catch (_) {}
            const found = msgs.find(m => m.id?._serialized === id);
            if (found) return found;
          }
        } catch (_) {}
        return null;
      }

      // ── Attempt download from a msg model or plain meta object ─────────────
      async function attemptDownload(msgObj, meta) {
        const errors = [];

        // 1. WWebJS injected helper
        try {
          if (window.WWebJS?.downloadMedia) {
            const r = await window.WWebJS.downloadMedia(msgObj || meta);
            if (r?.data) return { data: r.data, mimetype: meta.mimetype };
          }
        } catch (e) { errors.push('WWebJS: ' + e.message); }

        // 2. DownloadManager — try any download-like function
        try {
          const buf = await tryDownloadManager(msgObj || { ...meta }, meta);
          if (buf) return { data: await bufToBase64(buf), mimetype: meta.mimetype };
        } catch (e) { errors.push('DM: ' + e.message); }

        // 3. Already-decrypted blob URL in memory (clientUrl)
        try {
          const url = (msgObj?.clientUrl) || meta.clientUrl;
          if (url) {
            const resp = await fetch(url);
            if (resp.ok) return { data: await bufToBase64(await resp.arrayBuffer()), mimetype: meta.mimetype };
          }
        } catch (e) { errors.push('clientUrl: ' + e.message); }

        // 4. Fetch encrypted + manual WebCrypto decrypt
        if (meta.mediaKey && (meta.mediaUrl || meta.directPath)) {
          try {
            const url = meta.mediaUrl || ('https://mmg.whatsapp.net' + meta.directPath);
            const resp = await fetch(url);
            if (resp.ok) {
              const encBuf = await resp.arrayBuffer();
              const plain = await decryptMedia(meta.mediaKey, encBuf, meta.type);
              return { data: await bufToBase64(plain), mimetype: meta.mimetype };
            } else {
              errors.push('fetch enc: HTTP ' + resp.status);
            }
          } catch (e) { errors.push('manual decrypt: ' + e.message); }
        }

        return { error: errors.join(' | ') || 'all download methods failed' };
      }

      // ── Main logic ─────────────────────────────────────────────────────────
      const msg = window.Store.Msg?.get(targetId) || findInStatusStores(targetId);

      if (msg) {
        const meta = {
          type: msg.type, mediaKey: typeof msg.mediaKey === 'string' ? msg.mediaKey : null,
          mediaKeyTimestamp: msg.mediaKeyTimestamp ?? msg.t,
          directPath: msg.directPath, mediaUrl: msg.mediaUrl,
          filehash: msg.filehash, mimetype: msg.mimetype || 'application/octet-stream',
          clientUrl: msg.clientUrl,
        };
        const r = await attemptDownload(msg, meta);
        if (r.data) return r;
        // fall through to cached metadata
      }

      if (cachedMeta && (cachedMeta.directPath || cachedMeta.mediaUrl || cachedMeta.mediaKey)) {
        const meta = { ...cachedMeta, mimetype: cachedMeta.mimetype || 'application/octet-stream' };
        return attemptDownload(null, meta);
      }

      // Return diagnostic info to help debug
      const dmKeys = Object.getOwnPropertyNames(window.Store.DownloadManager || {})
        .filter(k => typeof window.Store.DownloadManager[k] === 'function');
      return { error: 'No message found and no cached metadata. DM functions: [' + dmKeys.join(', ') + ']' };
    }, msgId, cachedMeta);

    if (result.error) {
      console.error('[DL] pupPage error:', result.error);
      return res.status(404).json({ error: result.error });
    }

    const ext = result.mimetype.split('/')[1]?.split(';')[0] || 'bin';
    const filename = `status_${Date.now()}.${ext}`;
    const buffer = Buffer.from(result.data, 'base64');
    await fs.outputFile(path.join(DOWNLOADS_DIR, filename), buffer);

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', result.mimetype);
    res.send(buffer);
  } catch (err) {
    console.error('[WA] Download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/download-all', async (req, res) => {
  if (!client || clientStatus !== 'ready') {
    return res.status(503).json({ error: 'Client not ready' });
  }
  const statuses = cachedStatuses.length ? cachedStatuses : await fetchStatuses();
  let saved = 0;
  const errors = [];

  for (const contact of statuses) {
    const contactDir = path.join(
      DOWNLOADS_DIR,
      (contact.contactName || contact.phone).replace(/[^a-z0-9_\- ]/gi, '_')
    );
    await fs.ensureDir(contactDir);

    for (const update of contact.updates) {
      if (!['image', 'video', 'audio', 'document'].includes(update.type)) continue;
      try {
        const result = await client.pupPage.evaluate(async (targetId) => {
          function findMsg(id) {
            const stores = ['StatusV3', 'Status', 'StatusRecent', 'StatusV2'];
            for (const name of stores) {
              const store = window.Store[name];
              if (!store) continue;
              const contacts = store.getModelsArray ? store.getModelsArray() : (store.models || []);
              for (const c of contacts) {
                const msgs = c.msgs?.getModelsArray ? c.msgs.getModelsArray() : [];
                const m = msgs.find(m => m.id?._serialized === id);
                if (m) return m;
              }
            }
            return window.Store.Msg?.get(id) || null;
          }
          const msg = findMsg(targetId);
          if (!msg) return { error: 'not found' };
          try {
            const buf = await window.Store.DownloadManager.downloadAndDecrypt(
              msg, msg.mediaKey, msg.mediaKeyTimestamp ?? msg.t,
              msg.directPath, msg.mediaUrl, msg.type, msg.filehash
            );
            const bytes = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < bytes.byteLength; i += 8192)
              bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
            return { data: btoa(bin), mimetype: msg.mimetype || 'application/octet-stream' };
          } catch(e) { return { error: e.message }; }
        }, update.id);

        if (result.error) { errors.push({ id: update.id, error: result.error }); continue; }
        const ext = result.mimetype.split('/')[1]?.split(';')[0] || 'bin';
        const filename = `${update.timestamp || Date.now()}.${ext}`;
        await fs.outputFile(path.join(contactDir, filename), Buffer.from(result.data, 'base64'));
        saved++;
      } catch (e) {
        errors.push({ id: update.id, error: e.message });
      }
    }
  }

  res.json({ saved, errors });
});

// ─── Chat helpers ─────────────────────────────────────────────────────────────

// Read messages purely from the in-memory WA Web store — NO UI navigation,
// NO openChat / openChatAt calls. Those functions internally call
// waitForChatLoading which crashes when the DOM component isn't mounted.
//
// Strategy:
//   1. Read from Store.Chat[id].msgs (populated for recent chats)
//   2. Fall back to scanning Store.Msg (global index, no navigation needed)
//   3. For "load earlier", use only backend-socket-level loaders on the
//      msgs collection itself (not UI openers)
async function readMessagesFromStore(chatId, limit = 50, beforeTs = null) {
  if (!client || clientStatus !== 'ready') return [];

  // ── Load earlier history via backend WebSocket (no UI navigation) ────────────
  if (beforeTs !== null) {
    await client.pupPage.evaluate(async (chatId) => {
      const chat = window.Store.Chat.get(chatId);
      if (!chat) return;

      // These call the WA backend socket directly — no DOM / React needed
      const loaders = [
        () => chat.msgs?.loadEarlierMsgs?.(),
        () => chat.msgs?.loadEarlierMessages?.(),
        () => window.WWebJS?.loadEarlierMessages?.(chatId),
        () => window.Store.ConversationMsgs?.fetchMessages?.(chat, { count: 50 }),
        () => window.Store.ConversationMsgs?.loadMessages?.(chat),
      ];
      for (const fn of loaders) {
        try {
          const r = fn();
          if (r && typeof r.then === 'function') await r;
          break;
        } catch (_) {}
      }
    }, chatId);

    await new Promise(r => setTimeout(r, 1500));
  }

  // ── Pure store read — never touches the UI ────────────────────────────────────
  return client.pupPage.evaluate((chatId, limit, before) => {
    let models = [];

    // Source 1: per-chat message collection
    try {
      const chat = window.Store.Chat.get(chatId);
      if (chat) {
        if (typeof chat.msgs?.getModelsArray === 'function') {
          models = chat.msgs.getModelsArray();
        } else if (chat.msgs?.models) {
          models = Array.from(chat.msgs.models);
        }
      }
    } catch (_) {}

    // Source 2: global Msg index (for chats not yet in per-chat collection)
    if (models.length === 0) {
      try {
        const all = window.Store.Msg?.getModelsArray?.() || [];
        models = all.filter(m => (m.id?.remote?._serialized || '') === chatId);
      } catch (_) {}
    }

    // Apply "before" pagination filter
    if (before) models = models.filter(m => (m.t || 0) < before);

    return models.slice(-limit).map(m => ({
      id: m.id?._serialized || String(Math.random()),
      body: m.body || '',
      fromMe: m.id?.fromMe ?? false,
      timestamp: m.t || 0,
      type: m.type || 'chat',
      author: m.author || null,
      caption: m.caption || '',
      hasMedia: !!(m.mediaKey || m.directPath),
      mimetype: m.mimetype || null,
    }));
  }, chatId, limit, beforeTs);
}

// ─── Chat endpoints ───────────────────────────────────────────────────────────

app.get('/api/chats', async (req, res) => {
  if (!client || clientStatus !== 'ready') return res.json([]);
  try {
    const chats = await client.getChats();
    const result = chats.slice(0, 150).map(c => ({
      id: c.id._serialized,
      name: c.name,
      isGroup: c.isGroup,
      lastMessage: c.lastMessage ? {
        body: c.lastMessage.body,
        timestamp: c.lastMessage.timestamp,
        fromMe: c.lastMessage.fromMe,
        type: c.lastMessage.type,
      } : null,
      unreadCount: c.unreadCount || 0,
      pinned: c.pinned || false,
    }));
    res.json(result);
  } catch (e) {
    console.error('[WA] getChats error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ?before=<unix_timestamp>  →  fetch 50 messages older than that timestamp
app.get('/api/messages/:chatId', async (req, res) => {
  if (!client || clientStatus !== 'ready') return res.json([]);
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const beforeTs = req.query.before ? Number(req.query.before) : null;
    const msgs = await readMessagesFromStore(chatId, 50, beforeTs);
    res.json(msgs);
  } catch (e) {
    console.error('[WA] messages error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send', async (req, res) => {
  const { chatId, message } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message required' });
  if (!client || clientStatus !== 'ready') return res.status(503).json({ error: 'not ready' });
  try {
    // sendMessage goes via WA WebSocket — does not require UI navigation
    const chat = await client.getChatById(chatId);
    const sent = await chat.sendMessage(message);
    res.json({ ok: true, id: sent.id._serialized });
  } catch (e) {
    console.error('[WA] send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin endpoints ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body || {};
  if (password && password === ADMIN_PASSWORD) {
    res.json({ ok: true, token: ADMIN_TOKEN });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.get('/api/admin/accounts', requireAdmin, async (req, res) => {
  if (!client || clientStatus !== 'ready') {
    return res.json([{ id: null, status: clientStatus }]);
  }
  try {
    const info = client.info;
    res.json([{
      id: info.wid._serialized,
      phone: info.wid.user,
      name: info.pushname,
      platform: info.platform,
      status: clientStatus,
    }]);
  } catch (e) {
    res.json([{ id: null, status: clientStatus, error: e.message }]);
  }
});

app.get('/api/admin/chats', requireAdmin, async (req, res) => {
  if (!client || clientStatus !== 'ready') return res.json([]);
  try {
    const chats = await client.getChats();
    const result = chats.map(c => ({
      id: c.id._serialized,
      name: c.name,
      isGroup: c.isGroup,
      lastMessage: c.lastMessage ? {
        body: c.lastMessage.body,
        timestamp: c.lastMessage.timestamp,
        fromMe: c.lastMessage.fromMe,
        type: c.lastMessage.type,
      } : null,
      unreadCount: c.unreadCount || 0,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ?before=<unix_timestamp>  →  earlier page of history
app.get('/api/admin/messages/:chatId', requireAdmin, async (req, res) => {
  if (!client || clientStatus !== 'ready') return res.json([]);
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const beforeTs = req.query.before ? Number(req.query.before) : null;
    const msgs = await readMessagesFromStore(chatId, 100, beforeTs);
    res.json(msgs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Stream download serve ────────────────────────────────────────────────────
// One-time token issued via socket; no extra auth header needed.
app.get('/api/stream/download/:token', (req, res) => {
  const entry = pendingDownloads.get(req.params.token);
  if (!entry || entry.expires < Date.now()) {
    return res.status(404).json({ error: 'Download link expired or not found' });
  }
  pendingDownloads.delete(req.params.token); // consume token
  const filePath = path.join(STREAM_DL_DIR, path.basename(entry.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath, entry.filename, (err) => {
    if (!err) setTimeout(() => fs.remove(filePath).catch(() => {}), 5000);
  });
});

app.post('/api/logout', async (req, res) => {
  try {
    if (client) await client.logout();
    clientStatus = 'disconnected';
    cachedStatuses = [];
    res.json({ ok: true });
    setTimeout(() => initClient(), 2000);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Browser screen streaming ─────────────────────────────────────────────────
// Screenshot the puppeteer page and stream frames to connected viewers.
// The page is already authenticated — no re-scan needed.

const streamViewers = new Set();   // sockets currently watching the stream
let streamTimer = null;
const STREAM_W = 1280;
const STREAM_H = 760;

async function ensureViewport() {
  if (!client?.pupPage) return;
  try {
    const vp = client.pupPage.viewport();
    if (!vp || vp.width !== STREAM_W || vp.height !== STREAM_H) {
      await client.pupPage.setViewport({ width: STREAM_W, height: STREAM_H });
    }
  } catch (_) {}
}

function startScreenStream() {
  if (streamTimer) return;
  streamTimer = setInterval(async () => {
    if (streamViewers.size === 0 || !client?.pupPage) return;
    try {
      const buf = await client.pupPage.screenshot({ type: 'jpeg', quality: 82 });
      const b64 = buf.toString('base64');
      streamViewers.forEach(s => s.volatile.emit('wa_frame', b64));
    } catch (_) {}
  }, 120); // ~8 fps
}

function stopScreenStream() {
  if (streamViewers.size === 0 && streamTimer) {
    clearInterval(streamTimer);
    streamTimer = null;
  }
}

// ─── Socket connections ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[IO] Client connected:', socket.id);
  socket.emit('status_state', { status: clientStatus, qr: currentQR });
  if (clientStatus === 'ready' && cachedStatuses.length > 0) {
    socket.emit('statuses_updated', cachedStatuses);
  }

  // ── Chat stream: start/stop ──────────────────────────────────────────────────
  socket.on('start_wa_stream', async () => {
    await ensureViewport();
    streamViewers.add(socket);
    startScreenStream();
    console.log('[Stream] Viewer joined. Total:', streamViewers.size);
  });

  socket.on('stop_wa_stream', () => {
    streamViewers.delete(socket);
    stopScreenStream();
    console.log('[Stream] Viewer left. Total:', streamViewers.size);
  });

  // ── Mouse ────────────────────────────────────────────────────────────────────
  socket.on('wa_click', async ({ x, y }) => {
    if (!client?.pupPage) return;
    try { await client.pupPage.mouse.click(x, y); } catch (_) {}
  });

  socket.on('wa_dblclick', async ({ x, y }) => {
    if (!client?.pupPage) return;
    try { await client.pupPage.mouse.click(x, y, { clickCount: 2 }); } catch (_) {}
  });

  socket.on('wa_rclick', async ({ x, y }) => {
    if (!client?.pupPage) return;
    try { await client.pupPage.mouse.click(x, y, { button: 'right' }); } catch (_) {}
  });

  socket.on('wa_scroll', async ({ x, y, deltaY }) => {
    if (!client?.pupPage) return;
    try {
      await client.pupPage.mouse.move(x, y);
      await client.pupPage.mouse.wheel({ deltaY });
    } catch (_) {}
  });

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  socket.on('wa_type', async ({ text }) => {
    if (!client?.pupPage) return;
    try { await client.pupPage.keyboard.type(text, { delay: 0 }); } catch (_) {}
  });

  socket.on('wa_key', async ({ key }) => {
    if (!client?.pupPage) return;
    try { await client.pupPage.keyboard.press(key); } catch (_) {}
  });

  socket.on('wa_hotkey', async ({ key, ctrl, shift, alt }) => {
    if (!client?.pupPage) return;
    try {
      if (ctrl)  await client.pupPage.keyboard.down('Control');
      if (shift) await client.pupPage.keyboard.down('Shift');
      if (alt)   await client.pupPage.keyboard.down('Alt');
      await client.pupPage.keyboard.press(key);
      if (alt)   await client.pupPage.keyboard.up('Alt');
      if (shift) await client.pupPage.keyboard.up('Shift');
      if (ctrl)  await client.pupPage.keyboard.up('Control');
    } catch (_) {}
  });

  // ── Grab media: click WA Web's own download button ──────────────────────────
  // This is far more reliable than reading blob data through the puppeteer
  // bridge. WA Web decrypts the file itself and the CDP download intercept
  // captures it to STREAM_DL_DIR, which our poller then pushes to the client.
  socket.on('wa_grab_video', async () => {
    if (!client?.pupPage) return;
    try {
      const clicked = await client.pupPage.evaluate(() => {
        // Try every known selector for the WA Web download button.
        // Order matters: media-viewer buttons first, then chat-level buttons.
        const selectors = [
          '[data-testid="media-download"]',
          '[data-icon="download"]',
          'button[aria-label="Download"]',
          '[data-testid="download"]',
          'span[data-icon="download"]',
          '[title="Download"]',
          '[aria-label="Download video"]',
          '[aria-label="Download image"]',
          '[data-testid="msg-dblbtn"]',
        ];
        for (const sel of selectors) {
          const els = Array.from(document.querySelectorAll(sel));
          // Prefer visible / non-hidden elements
          const el = els.find(e => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }) || els[0];
          if (el) {
            (el.closest('button, [role="button"]') || el).click();
            return sel;
          }
        }
        return null;
      });

      if (clicked) {
        console.log('[WA] Clicked download button:', clicked);
        // The CDP download intercept will capture the file automatically.
        // The polling loop will notify the client once it lands in STREAM_DL_DIR.
      } else {
        socket.emit('wa_grab_error', 'No download button found — open a photo or video first, then click Grab');
      }
    } catch (e) {
      console.error('[WA] wa_grab_video error:', e.message);
      socket.emit('wa_grab_error', e.message);
    }
  });

  // ── Clipboard paste ───────────────────────────────────────────────────────────
  socket.on('wa_paste', async ({ text }) => {
    if (!client?.pupPage || !text) return;
    try { await client.pupPage.keyboard.type(text, { delay: 0 }); } catch (_) {}
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    streamViewers.delete(socket);
    stopScreenStream();
    console.log('[IO] Client disconnected:', socket.id);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  initClient();
});

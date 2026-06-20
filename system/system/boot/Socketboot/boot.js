#!/usr/bin/env node
'use strict';

/**
 * Limbo Socketboot Server
 * ------------------------
 * Dies ist der "Socket"-Server: Wenn das System ueber `node boot.js`
 * gestartet wird, laeuft es im Socket-Modus mit Schreibberechtigung
 * (sofern das Dateisystem das zulaesst). Statische Dateien werden direkt
 * vom Projekt-Root ausgeliefert, zusaetzlich gibt es eine kleine
 * Schreib-API fuer JSON-Dateien unter /system/data/.
 *
 * Wichtig: Das System muss IMMER funktionieren, egal ob der Prozess
 * Schreibrechte auf dem Dateisystem hat oder nicht:
 *   - Mit Schreibrechten: environment.info wird automatisch auf
 *     has_socket=true gesetzt, Setup-/Account-Daten werden serverseitig
 *     als JSON-Dateien gespeichert.
 *   - Ohne Schreibrechte (z.B. Read-Only-Filesystem/Container): Der
 *     Server laeuft trotzdem (rein lesend), liefert aber bei Schreib-
 *     versuchen eine saubere Fehlermeldung statt abzustuerzen. Das
 *     Frontend (first-startup.html) faengt das ab und weicht automatisch
 *     auf localStorage aus.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { URL } = require('url');

// ---------------------------------------------------------------------
// Pfade
// ---------------------------------------------------------------------
// boot.js liegt unter: <ROOT>/system/system/boot/Socketboot/boot.js
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'system', 'data');
const ENV_INFO_PATH = path.join(ROOT_DIR, 'system', 'etc', 'info', 'host', 'environment.info');
const ERROR_404_PATH = path.join(ROOT_DIR, 'system', 'system', 'errors', 'server', '404.html');
const ERROR_500_PATH = path.join(ROOT_DIR, 'system', 'system', 'errors', 'server', '500.html');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.info': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8'
};

// Wird beim Start einmal ermittelt und steuert, ob Schreib-Requests
// ueberhaupt versucht werden.
let WRITE_PERMISSION = false;

// ---------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------

/**
 * Prueft per Testschreibvorgang, ob der Prozess tatsaechlich auf
 * system/data schreiben darf (nicht nur, ob die Datei existiert).
 */
async function checkWritePermission() {
    const testFile = path.join(DATA_DIR, '.write-test-' + process.pid + '-' + Date.now());
    try {
        await fsp.mkdir(DATA_DIR, { recursive: true });
        await fsp.writeFile(testFile, 'ok');
        await fsp.unlink(testFile);
        return true;
    } catch {
        return false;
    }
}

/**
 * Gleicht environment.info mit der tatsaechlich erkannten
 * Schreibberechtigung ab. Andere Felder (one_time, is_admin) bleiben
 * unangetastet. Schlaegt das Schreiben fehl (keine Rechte), wird das
 * stillschweigend uebersprungen -- der mitgelieferte Default
 * (has_socket: false) bleibt dann einfach bestehen, was dem realen
 * Zustand entspricht.
 */
async function syncEnvironmentInfo(hasSocket) {
    let current = { has_socket: false, one_time: false, is_admin: false };
    try {
        const raw = await fsp.readFile(ENV_INFO_PATH, 'utf8');
        current = { ...current, ...JSON.parse(raw) };
    } catch {
        // Datei fehlt oder ist kaputtes JSON -> mit Defaults weiterarbeiten.
    }

    if (current.has_socket === hasSocket) return;
    current.has_socket = hasSocket;

    if (!hasSocket) return; // ohne Schreibrechte koennen wir die Datei nicht korrigieren

    try {
        await fsp.mkdir(path.dirname(ENV_INFO_PATH), { recursive: true });
        await fsp.writeFile(ENV_INFO_PATH, JSON.stringify(current, null, 2));
        console.log('[Limbo] environment.info aktualisiert -> has_socket:', hasSocket);
    } catch (err) {
        console.warn('[Limbo] Konnte environment.info nicht aktualisieren:', err.message);
    }
}

function isPathInside(parentDir, targetPath) {
    const rel = path.relative(parentDir, targetPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Loest einen URL-Pfad sicher gegen Path-Traversal auf. */
function safeResolve(urlPathname) {
    const decoded = decodeURIComponent(urlPathname);
    const target = path.normalize(path.join(ROOT_DIR, decoded));
    if (!isPathInside(ROOT_DIR, target)) return null;
    return target;
}

async function sendFile(res, filePath, statusCode, headOnly) {
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    try {
        const data = await fsp.readFile(filePath);
        res.writeHead(statusCode, { 'Content-Type': type, 'Content-Length': data.length });
        res.end(headOnly ? undefined : data);
        return true;
    } catch {
        return false;
    }
}

async function send404(res, headOnly) {
    const ok = await sendFile(res, ERROR_404_PATH, 404, headOnly);
    if (!ok) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(headOnly ? undefined : '404 Not Found');
    }
}

async function send500(res, headOnly) {
    const ok = await sendFile(res, ERROR_500_PATH, 500, headOnly);
    if (!ok) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(headOnly ? undefined : '500 Internal Server Error');
    }
}

function sendJson(res, statusCode, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const MAX_BYTES = 5 * 1024 * 1024; // 5 MB Sicherheitslimit
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BYTES) {
                reject(new Error('Payload too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// ---------------------------------------------------------------------
// Request-Handler
// ---------------------------------------------------------------------

async function handleGetOrHead(req, res) {
    const headOnly = req.method === 'HEAD';
    const reqUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    let pathname = reqUrl.pathname;
    if (pathname === '/') pathname = '/index.html';

    const filePath = safeResolve(pathname);
    if (!filePath) { await send404(res, headOnly); return; }

    let stat;
    try {
        stat = await fsp.stat(filePath);
    } catch {
        stat = null;
    }

    if (!stat) { await send404(res, headOnly); return; }

    if (stat.isDirectory()) {
        // Versuche index.html innerhalb des Verzeichnisses
        const indexPath = path.join(filePath, 'index.html');
        const ok = await sendFile(res, indexPath, 200, headOnly);
        if (!ok) await send404(res, headOnly);
        return;
    }

    const ok = await sendFile(res, filePath, 200, headOnly);
    if (!ok) await send404(res, headOnly);
}

async function handlePost(req, res) {
    const reqUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const filePath = safeResolve(reqUrl.pathname);

    // Schreibzugriffe sind ausschliesslich innerhalb von /system/data/ auf
    // .json-Dateien erlaubt -- alles andere wird abgelehnt.
    if (!filePath || !isPathInside(DATA_DIR, filePath) || path.extname(filePath) !== '.json') {
        sendJson(res, 403, { error: 'Schreibzugriff auf diesen Pfad ist nicht erlaubt.' });
        return;
    }

    if (!WRITE_PERMISSION) {
        sendJson(res, 503, {
            error: 'Der Server hat keine Schreibberechtigung auf dem Dateisystem. Bitte stattdessen lokalen Speicher (localStorage) verwenden.'
        });
        return;
    }

    let payload;
    try {
        const raw = await readRequestBody(req);
        payload = JSON.parse(raw.length ? raw.toString('utf8') : '{}');
    } catch (err) {
        sendJson(res, 400, { error: 'Ungueltiges JSON im Request-Body: ' + err.message });
        return;
    }

    try {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, JSON.stringify(payload, null, 2));
        sendJson(res, 200, { success: true });
    } catch (err) {
        console.error('[Limbo] Schreibfehler:', err.message);
        sendJson(res, 500, { error: 'Datei konnte nicht geschrieben werden: ' + err.message });
    }
}

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'GET' || req.method === 'HEAD') {
            await handleGetOrHead(req, res);
        } else if (req.method === 'POST') {
            await handlePost(req, res);
        } else {
            res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD, POST' });
            res.end('405 Method Not Allowed');
        }
    } catch (err) {
        console.error('[Limbo] Unerwarteter Fehler bei der Anfrageverarbeitung:', err);
        try { await send500(res, req.method === 'HEAD'); } catch { res.end(); }
    }
});

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------

async function start() {
    WRITE_PERMISSION = await checkWritePermission();
    await syncEnvironmentInfo(WRITE_PERMISSION);

    server.listen(PORT, HOST, () => {
        console.log('');
        console.log('  Limbo Socketboot');
        console.log('  ----------------------------------------------');
        console.log('  URL:                  http://localhost:' + PORT + '/');
        console.log('  Root-Verzeichnis:      ' + ROOT_DIR);
        console.log('  Schreibberechtigung:   ' + (WRITE_PERMISSION ? 'JA (Socket-Modus aktiv)' : 'NEIN (Fallback auf localStorage im Browser)'));
        console.log('');
    });
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error('[Limbo] Port ' + PORT + ' ist bereits belegt. Setze die Umgebungsvariable PORT, um einen anderen Port zu verwenden.');
    } else {
        console.error('[Limbo] Server-Fehler:', err.message);
    }
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    console.error('[Limbo] Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('[Limbo] Unhandled Rejection:', err);
});

start();

#!/usr/bin/env node
/**
 * Soundboard Server
 * Runs on your PC — serves the web UI to your phone and handles audio playback.
 *
 * Usage:
 *   node server.js [audio-folder] [port]
 *   node server.js ~/Music/soundboard 3000
 *
 * Defaults: ./sounds   port 3000
 */

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { exec, spawn } = require('child_process');
const os      = require('os');

// ── Config ────────────────────────────────────────────────────────────────────
const SOUNDS_DIR = path.resolve(process.argv[2] || path.join(process.cwd(), 'sounds'));
const PORT       = parseInt(process.argv[3] || '3000', 10);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.opus', '.weba', '.webm']);

// ── State ─────────────────────────────────────────────────────────────────────
let micEnabled   = false;
let currentSound = null;   // currently playing ffmpeg process

// ── Persistent PipeWire streams (qpwgraph-friendly) ──────────────────────────
//
// Two long-lived named nodes visible in qpwgraph:
//   "Soundboard Output"  — pipe audio into this; wire it to speakers in qpwgraph
//   "Soundboard Mic"     — wire your mic source into this in qpwgraph
//
// We use `pw-cat` with minimal flags that work across PipeWire versions.
// If pw-cat keeps failing we give up after 5 attempts rather than looping forever.

let sinkProc      = null;
let micProc       = null;
let sinkReady     = false;
let sinkFailures  = 0;
let micFailures   = 0;
const MAX_FAILS   = 5;

function startSinkNode() {
  if (sinkProc) return;
  if (sinkFailures >= MAX_FAILS) {
    console.error('[sink] pw-cat failed too many times — giving up. Playback will use ffplay directly.');
    return;
  }

  sinkProc = spawn('pw-cat', [
    '--playback',
    '--raw',
    '--rate', '48000',
    '--channels', '2',
    '--format', 's16',
    '-P', '{ "media.name": "Soundboard Output", "node.name": "soundboard-output" }',
    '-',
  ], { stdio: ['pipe', 'ignore', 'pipe'] });

  sinkProc.stderr.on('data', d => console.error('[sink]', d.toString().trim()));

  sinkProc.on('error', err => {
    console.error('[sink] pw-cat error:', err.message);
    sinkProc = null; sinkReady = false; sinkFailures++;
    setTimeout(startSinkNode, 2000);
  });
  sinkProc.on('close', code => {
    console.warn(`[sink] pw-cat exited (${code})`);
    sinkProc = null; sinkReady = false; sinkFailures++;
    setTimeout(startSinkNode, 2000);
  });

  setTimeout(() => {
    if (sinkProc) { sinkReady = true; sinkFailures = 0; console.log('[sink] Soundboard Output node ready'); }
  }, 800);
  console.log('[sink] starting Soundboard Output node…');
}

// pw-loopback creates a proper capture→playback node pair:
//   "Soundboard Mic [in]"  — wire your mic source into this in qpwgraph
//   "Soundboard Mic [out]" — wire this to your headset output in qpwgraph
//
// Unlike pw-cat --record, pw-loopback is a real stream owned by the session
// manager so wpctl set-volume actually works on it. Discord uses the system
// default mic source directly — completely unaffected by muting this node.

function startMicNode() {
  if (micProc) return;
  if (micFailures >= MAX_FAILS) {
    console.error('[mic] pw-loopback failed too many times — giving up.');
    return;
  }

  micProc = spawn('pw-loopback', [
    '--capture-props',
    'media.name="Soundboard Mic" node.name=soundboard-mic-cap node.description="Soundboard Mic [in]"',
    '--playback-props',
    'media.name="Soundboard Mic" node.name=soundboard-mic-play node.description="Soundboard Mic [out]"',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  micProc.stderr.on('data', d => console.error('[mic]', d.toString().trim()));

  micProc.on('error', err => {
    console.error('[mic] pw-loopback error:', err.message);
    micProc = null; micFailures++;
    setTimeout(startMicNode, 2000);
  });
  micProc.on('close', code => {
    console.warn(`[mic] pw-loopback exited (${code})`);
    micProc = null; micFailures++;
    setTimeout(startMicNode, 2000);
  });

  console.log('[mic] Soundboard Mic loopback started');
  console.log('[mic]   In qpwgraph: wire your mic → "Soundboard Mic [in]"');
  console.log('[mic]                wire "Soundboard Mic [out]" → your headset');
}

// Mute by zeroing the volume on the playback (output) node — this silences
// what reaches your headset without killing the loopback or touching Discord.
function setMicMute(muted) {
  exec('pw-dump Node', (err, stdout) => {
    if (err) { console.warn('[mic] pw-dump failed:', err.message.trim()); return; }
    let nodes;
    try { nodes = JSON.parse(stdout); } catch (e) {
      console.warn('[mic] pw-dump JSON parse failed:', e.message); return;
    }
    const playNode = nodes.find(n =>
      n.info?.props?.['node.name'] === 'soundboard-mic-play'
    );
    if (!playNode) { console.warn('[mic] soundboard-mic-play node not found'); return; }

    exec(`wpctl set-volume ${playNode.id} ${muted ? '0' : '1'}`, err2 => {
      if (err2) console.warn('[mic] wpctl set-volume:', err2.message.trim());
      else console.log(`[mic] ${muted ? 'muted' : 'unmuted'} (playback node ${playNode.id})`);
    });
  });
}

// ── Audio playback ────────────────────────────────────────────────────────────
// ffmpeg → raw PCM → pw-cat sink stdin when the node is up.
// Falls back to ffplay (spawns its own PipeWire node) if the sink isn't ready.

function playSound(filename) {
  const filePath = path.join(SOUNDS_DIR, filename);

  if (!filePath.startsWith(SOUNDS_DIR + path.sep) && filePath !== SOUNDS_DIR) {
    console.warn('[play] Path traversal blocked:', filename);
    return { ok: false, error: 'Invalid path' };
  }
  if (!fs.existsSync(filePath)) return { ok: false, error: 'File not found' };

  // Stop whatever is currently playing
  if (currentSound) {
    try {
      currentSound.stdout && currentSound.stdout.unpipe();
      currentSound.kill('SIGKILL');
    } catch (_) {}
    currentSound = null;
  }

  if (sinkProc && sinkReady) {
    const ff = spawn('ffmpeg', [
      '-loglevel', 'quiet',
      '-i', filePath,
      '-f', 's16le', '-ar', '48000', '-ac', '2',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    ff.stdout.pipe(sinkProc.stdin, { end: false });
    ff.on('close', () => { if (currentSound === ff) { currentSound = null; broadcast({ type: 'stopped' }); } });
    ff.on('error', err => console.error('[play] ffmpeg error:', err.message));
    currentSound = ff;
  } else {
    console.warn('[play] sink not ready, falling back to ffplay');
    const ff = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath]);
    ff.on('close', () => { if (currentSound === ff) { currentSound = null; broadcast({ type: 'stopped' }); } });
    ff.on('error', err => console.error('[play] ffplay error:', err.message));
    currentSound = ff;
  }

  console.log('[play]', filename);
  return { ok: true };
}

function stopSound() {
  if (currentSound) {
    try { currentSound.kill('SIGKILL'); } catch (_) {}
    currentSound = null;
    console.log('[play] stopped');
  }
}

// ── File listing ──────────────────────────────────────────────────────────────
function listSounds() {
  if (!fs.existsSync(SOUNDS_DIR)) {
    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    return [];
  }
  return fs.readdirSync(SOUNDS_DIR)
    .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// ── HTTP + WebSocket server (no dependencies) ─────────────────────────────────
// Minimal WebSocket handshake & framing implementation
const crypto = require('crypto');

function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function wsParseFrame(buf) {
  if (buf.length < 2) return null;
  const fin    = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len      = buf[1] & 0x7f;
  let offset   = 2;

  if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }

  if (buf.length < offset + (masked ? 4 : 0) + len) return null;

  let payload;
  if (masked) {
    const mask = buf.slice(offset, offset + 4);
    offset += 4;
    payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ mask[i % 4];
  } else {
    payload = buf.slice(offset, offset + len);
    offset += len;
  }

  return { opcode, payload, consumed: offset };
}

function wsSendText(socket, data) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  const frame   = Buffer.alloc(2 + payload.length);
  frame[0] = 0x81; // FIN + text opcode
  frame[1] = payload.length; // no masking from server
  payload.copy(frame, 2);
  socket.write(frame);
}

// ── Serve static files ────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.ico':  'image/x-icon',
};

const PUBLIC_DIR = path.join(__dirname, 'public');

function serveStatic(req, res) {
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
  // stay inside public/
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── API handler ───────────────────────────────────────────────────────────────
function handleAPI(req, res) {
  const url = new URL(req.url, `http://localhost`);

  // GET /api/sounds  — list available sounds
  if (req.method === 'GET' && url.pathname === '/api/sounds') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sounds: listSounds(), micEnabled }));
    return;
  }

  // POST /api/play  body: { file }
  if (req.method === 'POST' && url.pathname === '/api/play') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { file } = JSON.parse(body);
        const result = playSound(file);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400); res.end('Bad JSON');
      }
    });
    return;
  }

  // POST /api/stop
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    stopSound();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/mic   body: { enabled: bool }
  if (req.method === 'POST' && url.pathname === '/api/mic') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { enabled } = JSON.parse(body);
        micEnabled = !!enabled;
        setMicMute(!micEnabled);
        broadcast({ type: 'mic', enabled: micEnabled });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, micEnabled }));
      } catch (e) {
        res.writeHead(400); res.end('Bad JSON');
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
}

// ── WebSocket clients ─────────────────────────────────────────────────────────
const clients = new Set();

// Heartbeat: ping all clients every 10s, drop ones that don't pong back
setInterval(() => {
  for (const s of clients) {
    if (s.destroyed || !s.writable) { clients.delete(s); continue; }
    if (s._missedPing) { s.destroy(); clients.delete(s); continue; }
    s._missedPing = true;
    // Send a WS ping frame (opcode 0x9)
    try { s.write(Buffer.from([0x89, 0x00])); } catch (_) { s.destroy(); clients.delete(s); }
  }
}, 10000);

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const sock of clients) {
    if (sock.destroyed || !sock.writable) { clients.delete(sock); continue; }
    try { wsSendText(sock, data); } catch (_) { clients.delete(sock); }
  }
}

// ── Main server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url.startsWith('/api/')) return handleAPI(req, res);
  serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') { socket.destroy(); return; }

  // Evict dead sockets first
  for (const s of clients) {
    if (s.destroyed || !s.writable) clients.delete(s);
  }

  wsHandshake(req, socket);
  socket._missedPing = false;
  clients.add(socket);

  wsSendText(socket, JSON.stringify({ type: 'init', sounds: listSounds(), micEnabled }));

  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const frame = wsParseFrame(buf);
      if (!frame) break;
      buf = buf.slice(frame.consumed);
      if (frame.opcode === 0x8) { socket.destroy(); break; }        // close
      if (frame.opcode === 0xa) { socket._missedPing = false; break; } // pong
      if (frame.opcode === 0x1) { // text
        try { handleWS(socket, JSON.parse(frame.payload.toString())); } catch (_) {}
      }
    }
  });

  socket.on('close', () => { clients.delete(socket); });
  socket.on('error', ()  => { clients.delete(socket); socket.destroy(); });
});

function handleWS(socket, msg) {
  if (msg.type === 'play' && msg.file) {
    const result = playSound(msg.file);
    if (result.ok) broadcast({ type: 'playing', file: msg.file });
  } else if (msg.type === 'stop') {
    stopSound();
    broadcast({ type: 'stopped' });
  } else if (msg.type === 'mic') {
    micEnabled = !!msg.enabled;
    setMicMute(!micEnabled);
    broadcast({ type: 'mic', enabled: micEnabled });
  } else if (msg.type === 'reload') {
    broadcast({ type: 'init', sounds: listSounds(), micEnabled });
  }
}

server.listen(PORT, '0.0.0.0', () => {
  // Print all LAN IPs for easy phone access
  const nets = os.networkInterfaces();
  const ips  = [];
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }

  console.log('\n🎛️  Soundboard server running!\n');
  console.log(`  Sounds folder : ${SOUNDS_DIR}`);
  console.log(`  Local         : http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  Phone (LAN)   : http://${ip}:${PORT}`));
  console.log('\nDrop audio files into the sounds folder, then open the URL on your phone.');
  console.log('\nIn qpwgraph you will see:');
  console.log('  • "Soundboard Output" — connect this to your speakers / virtual cable');
  console.log('  • "Soundboard Mic"    — connect your mic source to this');
  console.log('\nPress Ctrl+C to stop.\n');

  // Start persistent PipeWire nodes immediately
  startSinkNode();
  startMicNode();
  // Mic starts muted; toggle from phone to unmute
  setTimeout(() => setMicMute(true), 1200);
});

process.on('SIGINT',  () => { stopSound(); if (sinkProc) sinkProc.kill(); if (micProc) micProc.kill(); process.exit(0); });
process.on('SIGTERM', () => { stopSound(); if (sinkProc) sinkProc.kill(); if (micProc) micProc.kill(); process.exit(0); });
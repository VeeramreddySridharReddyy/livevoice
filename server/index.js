import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { createSttStream } from './stt/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Pretty shareable link: /room/ABCDE -> receiver page (code read client-side).
app.get('/room/:code', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'receiver.html'));
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// BYOK model: each speaker brings their own Deepgram key. It is validated
// here, then held in memory for that room only — never written to disk.
// A server-side env key (local dev convenience) makes the key prompt optional.
function serverKeyConfigured() {
  const provider = (process.env.STT_PROVIDER || 'deepgram').toLowerCase();
  const key = provider === 'assemblyai'
    ? process.env.ASSEMBLYAI_API_KEY
    : process.env.DEEPGRAM_API_KEY;
  return !!key && !/your_.*_key_here/i.test(key);
}

app.get('/api/status', (_req, res) => {
  res.json({
    serverKeyConfigured: serverKeyConfigured(),
    provider: (process.env.STT_PROVIDER || 'deepgram').toLowerCase(),
  });
});

// Verify a speaker's key against Deepgram (proxied here to avoid CORS and
// keep a single trust path). Nothing is stored.
app.post('/api/validate-key', async (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim();
  if (!apiKey || apiKey.length < 10) {
    return res.status(400).json({ ok: false, error: 'Please paste a valid Deepgram API key.' });
  }
  try {
    const r = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${apiKey}` },
    });
    if (!r.ok) {
      return res.status(400).json({
        ok: false,
        error: r.status === 401
          ? 'Deepgram rejected this key (401). Double-check you copied the full key.'
          : `Deepgram returned ${r.status}. Try again in a moment.`,
      });
    }
  } catch {
    return res.status(502).json({ ok: false, error: 'Could not reach Deepgram to verify the key. Check your internet connection.' });
  }
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new RoomManager();

// ---- helpers ----
function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastStatus(room) {
  const status = {
    type: 'status',
    speakerConnected: !!room.speaker,
    receiverConnected: !!room.receiver,
  };
  send(room.speaker, status);
  send(room.receiver, status);
}

function broadcastTranscript(room, payload) {
  const msg = { type: 'transcript', ...payload };
  send(room.speaker, msg);
  send(room.receiver, msg);
}

function startStt(room, sampleRate) {
  if (room.stt) { try { room.stt.finish(); } catch { /* ignore */ } room.stt = null; }
  if (!room.sttKey && !serverKeyConfigured()) {
    send(room.speaker, {
      type: 'stt', state: 'error', code: 'no_key',
      message: 'Enter your Deepgram API key to start transcribing.',
    });
    return;
  }
  room.stt = createSttStream({
    apiKey: room.sttKey || undefined, // speaker's own key (BYOK)
    sampleRate,
    onOpen: () => send(room.speaker, { type: 'stt', state: 'ready' }),
    onTranscript: (t) => {
      if (t.isFinal) {
        // memory-only, for refresh-restore; newPara tells clients where
        // paragraphs begin so everyone renders identically.
        const newPara = room.addFinal(t.text);
        broadcastTranscript(room, { ...t, newPara });
      } else {
        broadcastTranscript(room, t);
      }
    },
    onError: (err) =>
      send(room.speaker, { type: 'stt', state: 'error', message: String(err?.message || err) }),
    onClose: () => { /* provider closed; room stays alive */ },
  });
}

function stopStt(room) {
  if (room.stt) { try { room.stt.finish(); } catch { /* ignore */ } room.stt = null; }
}

function isAliveSocket(ws) {
  return !!ws && ws.readyState === ws.OPEN;
}

// ---- message handlers ----
function handleJoin(ws, msg) {
  const clientId = String(msg.clientId || '');

  if (msg.role === 'speaker') {
    let room;
    if (msg.roomCode) {
      room = rooms.get(msg.roomCode) || rooms.createWithCode(msg.roomCode);
    } else {
      room = rooms.create();
    }
    // Same client (refresh/reconnect) takes over; a different live speaker is rejected.
    if (isAliveSocket(room.speaker) && room.speaker !== ws) {
      if (clientId && room.speakerClientId === clientId) {
        try { room.speaker.close(4000, 'replaced'); } catch { /* ignore */ }
      } else {
        send(ws, { type: 'error', code: 'speaker_exists', message: 'This room already has a speaker.' });
        return;
      }
    }
    room.speaker = ws;
    room.speakerClientId = clientId || room.speakerClientId;
    ws.role = 'speaker';
    ws.room = room;
    room.touch();
    send(ws, { type: 'joined', role: 'speaker', roomCode: room.code });
    if (room.paras.length) send(ws, { type: 'history', paras: room.paras });
    broadcastStatus(room);
    return;
  }

  if (msg.role === 'receiver') {
    const room = rooms.get(msg.roomCode);
    if (!room) {
      send(ws, { type: 'error', code: 'room_not_found', message: 'Room not found. Check the code.' });
      return;
    }
    // One-to-one: a *different* live receiver blocks the seat; the same
    // client refreshing takes its seat back.
    if (isAliveSocket(room.receiver) && room.receiver !== ws) {
      if (clientId && room.receiverClientId === clientId) {
        try { room.receiver.close(4000, 'replaced'); } catch { /* ignore */ }
      } else {
        send(ws, { type: 'error', code: 'room_full', message: 'This room already has a receiver.' });
        return;
      }
    }
    room.receiver = ws;
    room.receiverClientId = clientId || room.receiverClientId;
    ws.role = 'receiver';
    ws.room = room;
    room.touch();
    send(ws, { type: 'joined', role: 'receiver', roomCode: room.code });
    if (room.paras.length) send(ws, { type: 'history', paras: room.paras });
    broadcastStatus(room);
    return;
  }

  send(ws, { type: 'error', code: 'bad_role', message: 'Unknown role.' });
}

function handleStart(ws, msg) {
  const room = ws.room;
  if (!room || ws.role !== 'speaker') return;
  // Speaker's own key rides along with 'start'; kept in memory for this
  // room only and dies with it.
  if (msg.apiKey) room.sttKey = String(msg.apiKey);
  startStt(room, msg.sampleRate || 16000);
  room.touch();
}

function handleAudio(ws, data) {
  const room = ws.room;
  if (!room || ws.role !== 'speaker' || !room.stt) return;
  room.stt.send(data);
  room.touch();
}

function handleStop(ws) {
  const room = ws.room;
  if (!room || ws.role !== 'speaker') return;
  stopStt(room);
}

// Speaker forces a paragraph break; both sides mirror it.
function handleBreak(ws) {
  const room = ws.room;
  if (!room || ws.role !== 'speaker') return;
  room.breakPara();
  send(room.speaker, { type: 'break' });
  send(room.receiver, { type: 'break' });
}

// Speaker wipes the shared transcript for everyone.
function handleClear(ws) {
  const room = ws.room;
  if (!room || ws.role !== 'speaker') return;
  room.clearHistory();
  send(room.speaker, { type: 'cleared' });
  send(room.receiver, { type: 'cleared' });
}

// Speaker explicitly ends the session: room is destroyed, receiver notified.
function handleEnd(ws) {
  const room = ws.room;
  if (!room || ws.role !== 'speaker') return;
  stopStt(room);
  send(room.receiver, { type: 'ended' });
  send(room.speaker, { type: 'ended' });
  if (room.receiver) { try { room.receiver.close(4001, 'ended'); } catch { /* ignore */ } }
  ws.room = null;
  rooms.delete(room.code);
}

function cleanupConnection(ws) {
  const room = ws.room;
  if (!room) return;
  if (ws.role === 'speaker' && room.speaker === ws) {
    room.speaker = null;
    stopStt(room); // stop billing/streaming as soon as speaker drops
    broadcastStatus(room);
  } else if (ws.role === 'receiver' && room.receiver === ws) {
    room.receiver = null;
    broadcastStatus(room);
  }
  room.touch();
  ws.room = null;
}

// ---- connection lifecycle ----
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.role = null;
  ws.room = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) { handleAudio(ws, data); return; }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg.type) {
      case 'join':  handleJoin(ws, msg); break;
      case 'start': handleStart(ws, msg); break;
      case 'stop':  handleStop(ws); break;
      case 'break': handleBreak(ws); break;
      case 'clear': handleClear(ws); break;
      case 'end':   handleEnd(ws); break;
      case 'leave': cleanupConnection(ws); break;
      default: break;
    }
  });

  ws.on('close', () => cleanupConnection(ws));
  ws.on('error', () => { /* swallow; close will follow */ });
});

// Heartbeat: drop dead sockets so rooms free up.
const HEARTBEAT_MS = 30000;
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch { /* ignore */ } return; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  });
}, HEARTBEAT_MS);
heartbeat.unref?.();

// Sweep idle empty rooms every minute (15 min grace keeps a link alive
// through brief disconnects/reconnects).
const ROOM_TTL_MS = 15 * 60 * 1000;
const sweeper = setInterval(() => rooms.sweep(ROOM_TTL_MS), 60 * 1000);
sweeper.unref?.();

server.listen(PORT, () => {
  const provider = (process.env.STT_PROVIDER || 'deepgram').toLowerCase();
  console.log(`LiveVoice listening on http://localhost:${PORT}  (STT provider: ${provider}, BYOK; local fallback key: ${serverKeyConfigured()})`);
});

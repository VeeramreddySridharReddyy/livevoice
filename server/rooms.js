// In-memory room registry. One-to-one: each room has at most one speaker and
// one receiver. Rooms are ephemeral (memory only, never persisted) and are
// swept when idle. A rolling transcript history lets a refreshed client
// restore the session until the speaker explicitly ends it.

// Unambiguous alphabet: no 0/O, 1/I/L to avoid confusion when sharing codes.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_PARAS = 300;      // paragraphs kept for refresh-restore
const PARA_GAP_MS = 2000;   // a pause this long starts a new paragraph

function genCode(n = 5) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

class Room {
  constructor(code) {
    this.code = code;
    this.speaker = null;          // WebSocket or null
    this.receiver = null;         // WebSocket or null
    this.speakerClientId = null;  // sessionStorage id -> refresh = same client
    this.receiverClientId = null;
    this.stt = null;              // active STT stream handle or null
    this.sttKey = null;           // speaker's own API key (memory only, BYOK)
    this.paras = [];              // finalized transcript paragraphs (memory only)
    this.paraOpen = false;        // false => next final starts a new paragraph
    this.lastFinalAt = 0;
    this.lastActive = Date.now();
  }
  touch() {
    this.lastActive = Date.now();
  }
  // Append a finalized segment. Returns true when it started a new paragraph
  // (manual break, first text, or a pause longer than PARA_GAP_MS).
  addFinal(text) {
    const now = Date.now();
    const newPara =
      !this.paraOpen || this.paras.length === 0 || now - this.lastFinalAt > PARA_GAP_MS;
    if (newPara) this.paras.push(text);
    else this.paras[this.paras.length - 1] += ' ' + text;
    if (this.paras.length > MAX_PARAS) this.paras.shift();
    this.paraOpen = true;
    this.lastFinalAt = now;
    return newPara;
  }
  breakPara() {
    this.paraOpen = false;
  }
  clearHistory() {
    this.paras = [];
    this.paraOpen = false;
  }
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  create() {
    let code;
    do { code = genCode(); } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  // Used when a speaker reconnects with a previously issued code so the
  // existing shareable link keeps working.
  createWithCode(code) {
    const norm = String(code).toUpperCase();
    const room = new Room(norm);
    this.rooms.set(norm, room);
    return room;
  }

  get(code) {
    return code ? this.rooms.get(String(code).toUpperCase()) : undefined;
  }

  delete(code) {
    const room = this.get(code);
    if (!room) return;
    if (room.stt) { try { room.stt.finish(); } catch { /* ignore */ } }
    this.rooms.delete(room.code);
  }

  // Remove empty rooms that have been idle longer than ttlMs.
  sweep(ttlMs) {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const empty = !room.speaker && !room.receiver;
      if (empty && now - room.lastActive > ttlMs) {
        if (room.stt) { try { room.stt.finish(); } catch { /* ignore */ } }
        this.rooms.delete(code);
      }
    }
  }
}

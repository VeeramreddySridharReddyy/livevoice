// Receiver: join a room over WebSocket and render the live transcript.
// Refreshing keeps the session (server replays history); the session only
// ends when the speaker clicks "End session".
(function () {
  const $ = (id) => document.getElementById(id);
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

  // Stable per-tab identity: survives refresh, distinct across tabs, so a
  // refresh reclaims our one-to-one seat but a second person is rejected.
  let clientId = sessionStorage.getItem('lv-client-id');
  if (!clientId) {
    clientId = 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('lv-client-id', clientId);
  }

  const joinCard = $('joinCard');
  const liveCard = $('liveCard');
  const joinForm = $('joinForm');
  const codeInput = $('codeInput');
  const joinToast = $('joinToast');

  const liveDot = $('liveDot');
  const connLabel = $('connLabel');
  const roomCodeEl = $('roomCode');
  const transcriptEl = $('transcript');
  const toast = $('toast');
  const fontUp = $('fontUp');
  const fontDown = $('fontDown');
  const clearBtn = $('clearBtn');

  let ws = null;
  let roomCode = null;
  let closingForGood = false;
  let reconnectDelay = 1000;
  let speakerConnected = false;
  // "Room not found" can be temporary: after a server restart the room only
  // reappears once the speaker's page reconnects. Retry before giving up.
  let notFoundRetries = 0;
  const MAX_NOT_FOUND_RETRIES = 5;

  // Paragraph-aware, smart-scrolling transcript renderer.
  const view = window.TranscriptView(transcriptEl, {
    emptyText: 'Waiting for the speaker to begin…',
  });

  // Restore preferred font size.
  let fontSize = 20;
  try { fontSize = parseInt(localStorage.getItem('lv-fontsize') || '20', 10) || 20; } catch (_) {}
  applyFont();

  // ---------- room detection ----------
  function detectRoom() {
    const m = location.pathname.match(/^\/room\/([^/]+)/i);
    if (m) return decodeURIComponent(m[1]).toUpperCase();
    const q = new URLSearchParams(location.search).get('room');
    return q ? q.toUpperCase() : null;
  }

  // ---------- helpers ----------
  function showToast(el, msg, kind) {
    el.textContent = msg;
    el.className = 'toast show ' + (kind || 'info');
  }
  function setConn(label) { connLabel.textContent = label; }
  function setLive(on) { liveDot.className = 'dot' + (on ? ' live' : ''); }

  function applyFont() {
    if (transcriptEl) transcriptEl.style.fontSize = fontSize + 'px';
    try { localStorage.setItem('lv-fontsize', String(fontSize)); } catch (_) {}
  }

  // ---------- websocket ----------
  function connect() {
    if (closingForGood) return;
    setConn('Connecting…');
    setLive(false);
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'join', role: 'receiver', roomCode, clientId }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      handleMsg(msg);
    };
    ws.onclose = (e) => {
      if (closingForGood || e.code === 4000 /* replaced by our own refresh */) return;
      if (e.code === 4001) { sessionEnded(); return; }
      setLive(false);
      setConn('Reconnecting…');
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(Math.floor(reconnectDelay * 1.7), 15000);
  }

  function sessionEnded() {
    closingForGood = true;
    setLive(false);
    setConn('Session ended by speaker');
    try { ws && ws.close(); } catch (_) {}
    showToast(toast, 'The speaker ended this session. Ask for a new room code to reconnect.', 'info');
  }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'joined':
        roomCode = msg.roomCode;
        roomCodeEl.textContent = roomCode;
        notFoundRetries = 0;
        setConn('Connected');
        break;
      case 'history':
        // Server replays the transcript (with paragraphs) after a refresh.
        view.setParas(msg.paras || []);
        break;
      case 'status':
        speakerConnected = !!msg.speakerConnected;
        setLive(speakerConnected);
        setConn(speakerConnected ? 'Live' : 'Waiting for speaker…');
        view.setEmptyText(speakerConnected ? 'Listening…' : 'Waiting for the speaker to begin…');
        break;
      case 'transcript':
        if (msg.isFinal) view.addFinal(msg.text, !!msg.newPara);
        else view.setInterim(msg.text);
        break;
      case 'break':
        view.breakPara();
        break;
      case 'cleared':
        view.clear();
        break;
      case 'ended':
        sessionEnded();
        break;
      case 'error':
        if (msg.code === 'room_not_found') {
          if (notFoundRetries < MAX_NOT_FOUND_RETRIES) {
            notFoundRetries++;
            setConn('Looking for the room… (' + notFoundRetries + '/' + MAX_NOT_FOUND_RETRIES + ')');
            try { ws.close(); } catch (_) {} // onclose schedules the retry with backoff
          } else {
            closingForGood = true;
            try { ws.close(); } catch (_) {}
            showJoin('Room "' + (roomCode || '') + '" was not found. Check the code, or ask the speaker to reopen their page.', 'err');
          }
        } else if (msg.code === 'room_full') {
          closingForGood = true;
          try { ws.close(); } catch (_) {}
          showJoin('That room already has a receiver connected.', 'err');
        } else {
          showToast(toast, msg.message || 'Error', 'err');
        }
        break;
    }
  }

  // ---------- views ----------
  function showLive() {
    joinCard.classList.add('hidden');
    liveCard.classList.remove('hidden');
    roomCodeEl.textContent = roomCode;
    connect();
  }
  function showJoin(msg, kind) {
    liveCard.classList.add('hidden');
    joinCard.classList.remove('hidden');
    if (msg) showToast(joinToast, msg, kind);
    if (roomCode) codeInput.value = roomCode;
  }

  // ---------- events ----------
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = codeInput.value.trim().toUpperCase();
    if (!code) return;
    roomCode = code;
    closingForGood = false;
    reconnectDelay = 1000;
    notFoundRetries = 0;
    // Reflect in URL so refresh/share keeps the session.
    history.replaceState(null, '', '/room/' + encodeURIComponent(code));
    showLive();
  });

  fontUp.addEventListener('click', () => { fontSize = Math.min(fontSize + 3, 56); applyFont(); });
  fontDown.addEventListener('click', () => { fontSize = Math.max(fontSize - 3, 14); applyFont(); });
  clearBtn.addEventListener('click', () => { view.clear(); });

  // Note: no 'leave' on pagehide — refresh must keep the seat; the clientId
  // takeover reclaims it and the heartbeat reaps truly dead sockets.

  // ---------- boot ----------
  roomCode = detectRoom();
  if (roomCode) showLive();
  else showJoin('', '');
})();

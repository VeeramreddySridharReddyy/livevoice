// Speaker: capture mic -> PCM16 over WebSocket -> server STT -> live transcript.
// Connects on page load so the room code appears immediately. Refreshing keeps
// the same room + transcript (via sessionStorage clientId & server history);
// only "End session" destroys the room.
(function () {
  const $ = (id) => document.getElementById(id);
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

  // Stable per-tab identity: survives refresh, distinct across tabs.
  let clientId = sessionStorage.getItem('lv-client-id');
  if (!clientId) {
    clientId = 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('lv-client-id', clientId);
  }

  // Elements
  const keyCard = $('keyCard');
  const keyForm = $('keyForm');
  const keyInput = $('keyInput');
  const keySaveBtn = $('keySaveBtn');
  const keyToast = $('keyToast');
  const changeKey = $('changeKey');
  const liveDot = $('liveDot');
  const connLabel = $('connLabel');
  const rxLabel = $('rxLabel');
  const roombox = $('roombox');
  const roomCodeEl = $('roomCode');
  const transcriptEl = $('transcript');
  const startBtn = $('startBtn');
  const stopBtn = $('stopBtn');
  const breakBtn = $('breakBtn');
  const clearBtn = $('clearBtn');
  const endBtn = $('endBtn');
  const copyCode = $('copyCode');
  const copyLink = $('copyLink');
  const toast = $('toast');

  // State — room survives refresh via sessionStorage + URL.
  let roomCode =
    new URLSearchParams(location.search).get('room') ||
    sessionStorage.getItem('lv-speaker-room') || null;
  if (roomCode) roomCode = roomCode.toUpperCase();

  let ws = null;
  let audioCtx = null, sourceNode = null, workletNode = null, mediaStream = null, sinkNode = null;
  let micReady = false;
  let streaming = false;
  let userWantsToStream = false; // intent survives reconnects
  let closingForGood = false;
  let reconnectDelay = 1000;

  // Paragraph-aware, smart-scrolling transcript renderer.
  const view = window.TranscriptView(transcriptEl, {
    emptyText: 'Your words will appear here as you speak.',
  });

  // ---------- UI helpers ----------
  function showToast(msg, kind) {
    toast.textContent = msg;
    toast.className = 'toast show ' + (kind || 'info');
  }
  function hideToast() { toast.className = 'toast'; }
  function setConn(label) { connLabel.textContent = label; }
  function setLive(on) { liveDot.className = 'dot' + (on ? ' live' : ''); }

  function updateRoomUI() {
    if (!roomCode) return;
    roomCodeEl.textContent = roomCode;
    roombox.classList.remove('hidden');
  }

  // ---------- BYOK key management ----------
  // The speaker's own Deepgram key lives in their browser (localStorage) and
  // rides along with 'start'. If the server has a local-dev env key, the
  // prompt is skipped entirely.
  let serverHasKey = false;

  function storedKey() {
    try { return localStorage.getItem('lv-dg-key') || ''; } catch (_) { return ''; }
  }
  function needsKey() {
    return !serverHasKey && !storedKey();
  }
  function updateKeyCard() {
    keyCard.classList.toggle('hidden', !needsKey());
  }
  function checkServerKey() {
    fetch('/api/status')
      .then((r) => r.json())
      .then((s) => { serverHasKey = !!s.serverKeyConfigured; updateKeyCard(); })
      .catch(() => updateKeyCard());
  }

  function showKeyToast(msg, kind) {
    keyToast.textContent = msg;
    keyToast.className = 'toast show ' + (kind || 'info');
  }

  keyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const key = keyInput.value.trim();
    if (!key) { showKeyToast('Paste your API key first.', 'err'); return; }
    keySaveBtn.disabled = true;
    keySaveBtn.textContent = 'Verifying…';
    fetch('/api/validate-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then((res) => {
        if (res.ok && res.j.ok) {
          try { localStorage.setItem('lv-dg-key', key); } catch (_) {}
          keyInput.value = '';
          updateKeyCard();
          showToast('✓ Key verified. Hit Start speaking when ready.', 'info');
        } else {
          showKeyToast(res.j.error || 'Could not verify the key.', 'err');
        }
      })
      .catch(() => showKeyToast('Could not reach the server. Is it running?', 'err'))
      .finally(() => {
        keySaveBtn.disabled = false;
        keySaveBtn.textContent = 'Save & verify';
      });
  });

  changeKey.addEventListener('click', (e) => {
    e.preventDefault();
    try { localStorage.removeItem('lv-dg-key'); } catch (_) {}
    serverHasKey = false; // force the card open even in local-dev
    keyCard.classList.remove('hidden');
    keyInput.focus();
  });

  // ---------- WebSocket ----------
  function connect() {
    if (closingForGood) return;
    setConn('Connecting…');
    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'join', role: 'speaker', roomCode: roomCode || undefined, clientId }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      handleMsg(msg);
    };
    ws.onclose = (e) => {
      streaming = false;
      setLive(false);
      if (closingForGood || e.code === 4000 /* replaced by our own refresh */) return;
      setConn('Reconnecting…');
      scheduleReconnect();
    };
    ws.onerror = () => { /* onclose handles retry */ };
  }

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(Math.floor(reconnectDelay * 1.7), 15000);
  }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'joined': {
        roomCode = msg.roomCode;
        sessionStorage.setItem('lv-speaker-room', roomCode);
        const url = new URL(location.href);
        url.searchParams.set('room', roomCode);
        history.replaceState(null, '', url);
        updateRoomUI();
        setConn('Connected');
        if (userWantsToStream && micReady) startStreaming();
        break;
      }
      case 'history':
        // Server restores the transcript (with paragraphs) after a refresh.
        view.setParas(msg.paras || []);
        break;
      case 'status':
        rxLabel.textContent = msg.receiverConnected ? 'Receiver: connected ✓' : 'Receiver: waiting…';
        rxLabel.style.color = msg.receiverConnected ? 'var(--ok)' : 'var(--muted)';
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
        endLocally();
        break;
      case 'stt':
        if (msg.state === 'error') {
          if (msg.code === 'no_key') {
            keyCard.classList.remove('hidden');
            keyInput.focus();
            showToast('Enter your Deepgram API key above to start transcribing.', 'err');
          } else {
            showToast('Transcription error: ' + (msg.message || 'unknown') + ' — if this repeats, try "Change API key".', 'err');
          }
        }
        break;
      case 'error':
        showToast(msg.message || 'Something went wrong.', 'err');
        break;
    }
  }

  // ---------- Audio ----------
  async function initMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('This browser does not support microphone capture.', 'err');
      throw new Error('unsupported');
    }
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      showToast('Microphone needs a secure (https) connection.', 'err');
      throw new Error('insecure');
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        showToast('Microphone permission was denied. Allow mic access and try again.', 'err');
      } else if (err.name === 'NotFoundError') {
        showToast('No microphone found on this device.', 'err');
      } else {
        showToast('Could not access microphone: ' + err.message, 'err');
      }
      throw err;
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    await audioCtx.audioWorklet.addModule('/js/pcm-worklet.js');
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
    workletNode.port.onmessage = (e) => {
      if (streaming && ws && ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };
    sourceNode.connect(workletNode);
    // Muted sink keeps the graph rendering without playing mic back (no feedback).
    sinkNode = audioCtx.createGain();
    sinkNode.gain.value = 0;
    workletNode.connect(sinkNode);
    sinkNode.connect(audioCtx.destination);

    micReady = true;
  }

  function startStreaming() {
    if (streaming || !ws || ws.readyState !== WebSocket.OPEN) return;
    streaming = true;
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    ws.send(JSON.stringify({
      type: 'start',
      sampleRate: audioCtx ? audioCtx.sampleRate : 16000,
      apiKey: storedKey() || undefined, // BYOK: this speaker's own key
    }));
    setLive(true);
    setConn('Live');
  }

  function endLocally() {
    closingForGood = true;
    streaming = false;
    userWantsToStream = false;
    setLive(false);
    setConn('Session ended');
    sessionStorage.removeItem('lv-speaker-room');
    try { mediaStream && mediaStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { ws && ws.close(); } catch (_) {}
    showToast('Session ended. Reload the page to start a new room.', 'info');
    startBtn.classList.add('hidden');
    stopBtn.classList.add('hidden');
    endBtn.textContent = 'New session';
    endBtn.classList.remove('danger');
    endBtn.onclick = () => { location.href = '/speaker.html'; };
  }

  // ---------- Buttons ----------
  startBtn.addEventListener('click', async () => {
    hideToast();
    if (needsKey()) {
      keyCard.classList.remove('hidden');
      keyInput.focus();
      showToast('Save your Deepgram API key first (box above).', 'err');
      return;
    }
    startBtn.disabled = true;
    try {
      if (!micReady) await initMic();
      userWantsToStream = true;
      if (!ws || ws.readyState === WebSocket.CLOSED) connect();
      else if (ws.readyState === WebSocket.OPEN && roomCode) startStreaming();
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } catch (_) {
      // toast already shown
    } finally {
      startBtn.disabled = false;
    }
  });

  stopBtn.addEventListener('click', () => {
    userWantsToStream = false;
    streaming = false;
    setLive(false);
    setConn('Paused');
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
    stopBtn.classList.add('hidden');
    startBtn.classList.remove('hidden');
  });

  breakBtn.addEventListener('click', () => {
    // New paragraph for both sides (server echoes 'break' to speaker + receiver).
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'break' }));
    else view.breakPara();
  });

  clearBtn.addEventListener('click', () => {
    // Clears for both speaker and receiver (server broadcasts 'cleared').
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'clear' }));
    view.clear();
  });

  endBtn.addEventListener('click', () => {
    if (!confirm('End this session for you and the receiver?')) return;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' }));
    endLocally();
  });

  copyCode.addEventListener('click', () => {
    if (!roomCode) return;
    copyText(roomCode, 'Room code copied');
  });
  copyLink.addEventListener('click', () => {
    if (!roomCode) return;
    copyText(location.origin + '/room/' + roomCode, 'Shareable link copied');
  });

  function copyText(text, okMsg) {
    const done = () => showToast(okMsg, 'info');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => prompt('Copy:', text));
    } else {
      prompt('Copy:', text);
    }
  }

  // Note: no 'leave' on pagehide — a refresh must keep the room. The server's
  // heartbeat reaps truly dead sockets, and 'End session' is the explicit exit.
  window.addEventListener('pagehide', () => {
    try { mediaStream && mediaStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  });

  // ---------- boot ----------
  if (roomCode) updateRoomUI();
  updateKeyCard();
  checkServerKey();
  connect(); // join/create the room right away so the code shows instantly
})();

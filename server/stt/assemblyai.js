// AssemblyAI streaming STT provider (Universal Streaming v3).
// Same uniform handle as Deepgram: { send(buffer), finish() }.
// Expects PCM16 mono audio; 16 kHz is recommended.
import WebSocket from 'ws';

export function createAssemblyAIStream({
  apiKey,
  sampleRate = 16000,
  onOpen,
  onTranscript,
  onError,
  onClose,
}) {
  if (!apiKey) {
    onError?.(new Error('ASSEMBLYAI_API_KEY is not set'));
    return { send() {}, finish() {} };
  }

  const url =
    'wss://streaming.assemblyai.com/v3/ws' +
    `?sample_rate=${sampleRate}&encoding=pcm_s16le&format_turns=true`;

  const socket = new WebSocket(url, { headers: { Authorization: apiKey } });

  socket.on('open', () => onOpen?.());

  socket.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.type === 'Turn') {
      const text = data.transcript || '';
      if (!text) return;
      // end_of_turn marks a finalized turn; turn_is_formatted marks the
      // punctuated/cased version. Treat either finalized signal as "final".
      onTranscript?.({
        text,
        isFinal: !!data.end_of_turn,
        speechFinal: !!data.turn_is_formatted,
      });
    }
  });

  socket.on('error', (err) => onError?.(err));
  socket.on('close', () => onClose?.());

  return {
    send(buffer) {
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(buffer); } catch (err) { onError?.(err); }
      }
    },
    finish() {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'Terminate' }));
        }
      } catch { /* ignore */ }
      try { socket.close(); } catch { /* ignore */ }
    },
  };
}

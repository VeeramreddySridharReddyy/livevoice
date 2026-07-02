// Deepgram streaming STT provider.
// Exposes a uniform stream handle: { send(buffer), finish() }.
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';

export function createDeepgramStream({
  apiKey,
  sampleRate = 16000,
  onOpen,
  onTranscript,
  onError,
  onClose,
}) {
  if (!apiKey) {
    onError?.(new Error('DEEPGRAM_API_KEY is not set'));
    return { send() {}, finish() {} };
  }

  const deepgram = createClient(apiKey);
  const connection = deepgram.listen.live({
    model: process.env.DEEPGRAM_MODEL || 'nova-2',
    language: process.env.DEEPGRAM_LANGUAGE || 'en-IN',
    encoding: 'linear16',
    sample_rate: sampleRate,
    channels: 1,
    interim_results: true, // stream partial words as they are recognized
    smart_format: true,
    punctuate: true,
    endpointing: 300,      // ms of silence before finalizing an utterance
  });

  connection.on(LiveTranscriptionEvents.Open, () => onOpen?.());

  connection.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data?.channel?.alternatives?.[0];
    const text = alt?.transcript || '';
    if (!text) return;
    onTranscript?.({
      text,
      isFinal: !!data.is_final,
      speechFinal: !!data.speech_final,
    });
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => onError?.(err));
  connection.on(LiveTranscriptionEvents.Close, () => onClose?.());

  // Keep the socket alive during silences so Deepgram doesn't time us out.
  const keepAlive = setInterval(() => {
    try { connection.keepAlive(); } catch { /* ignore */ }
  }, 8000);

  return {
    send(buffer) {
      try { connection.send(buffer); } catch (err) { onError?.(err); }
    },
    finish() {
      clearInterval(keepAlive);
      try {
        if (typeof connection.requestClose === 'function') connection.requestClose();
        else if (typeof connection.finish === 'function') connection.finish();
      } catch { /* ignore */ }
    },
  };
}

// STT provider factory. The active provider is chosen by STT_PROVIDER.
// API keys are read from the environment here so they never leave the server.
import { createDeepgramStream } from './deepgram.js';
import { createAssemblyAIStream } from './assemblyai.js';

export function createSttStream(opts) {
  const provider = (process.env.STT_PROVIDER || 'deepgram').toLowerCase();

  if (provider === 'assemblyai') {
    return createAssemblyAIStream({
      ...opts,
      // BYOK: the speaker's own key wins; env key is a local-dev fallback.
      apiKey: opts.apiKey || process.env.ASSEMBLYAI_API_KEY,
    });
  }

  // default: deepgram
  return createDeepgramStream({
    ...opts,
    apiKey: opts.apiKey || process.env.DEEPGRAM_API_KEY,
  });
}

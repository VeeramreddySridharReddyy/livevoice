// AudioWorklet: captures mic audio and emits PCM16 (linear16) frames.
// Buffers to ~24 ms per message (3 × 128-sample render quanta) — the smallest
// frame that still divides evenly into the worklet's callback size, so audio
// reaches the STT engine with minimal buffering delay.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._target = 384; // 3 render quanta = 24 ms at 16 kHz
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      for (let i = 0; i < channel.length; i++) this._buf.push(channel[i]);
      if (this._buf.length >= this._target) {
        const pcm = new Int16Array(this._buf.length);
        for (let i = 0; i < this._buf.length; i++) {
          let s = Math.max(-1, Math.min(1, this._buf[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this._buf = [];
      }
    }
    return true; // keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor);

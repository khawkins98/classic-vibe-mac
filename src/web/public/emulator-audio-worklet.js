/**
 * emulator-audio-worklet.js — AudioWorklet processor for Mac audio playback.
 *
 * Runs in the AudioWorkletGlobalScope (separate realm from the main thread).
 * Receives raw PCM chunks via this.port from emulator-loader.ts, queues them,
 * and plays them back sample-by-sample in the real-time process() callback.
 *
 * Message protocol (port.onmessage):
 *   { type: "data", data: Uint8Array }        — push a PCM chunk onto the queue
 *   { type: "reset" }                          — flush the queue (emulator reboot)
 *
 * processorOptions:
 *   sampleSize: 8 | 16 | 32                   — bits per sample (default 16)
 *
 * Classic Mac audio (System 7 / BasiliskII) typically produces 22050 Hz,
 * big-endian 16-bit signed mono PCM. All sample reads use big-endian DataView
 * calls to match the m68k native byte order.
 */

class CvmAudioProcessor extends AudioWorkletProcessor {
  #queue = [];    // Array<Uint8Array> — pending PCM chunks
  #offset = 0;   // byte offset within queue[0]
  #sampleSize;   // bits per sample

  constructor(options) {
    super();
    this.#sampleSize = options?.processorOptions?.sampleSize ?? 16;

    this.port.onmessage = (ev) => {
      if (ev.data.type === "data") {
        this.#queue.push(ev.data.data);
      } else if (ev.data.type === "reset") {
        this.#queue = [];
        this.#offset = 0;
      }
    };
  }

  process(_inputs, outputs, _params) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const sampleCount = output[0].length; // always 128 frames in an AudioWorklet
    const bytesPerSample = this.#sampleSize >> 3;
    const channels = output.length;

    for (let i = 0; i < sampleCount; i++) {
      const sample = this.#nextSample(bytesPerSample);
      for (let ch = 0; ch < channels; ch++) {
        output[ch][i] = sample;
      }
    }

    return true; // keep processor alive
  }

  /**
   * Read the next PCM sample from the queue and advance the read pointer.
   * Returns 0 (silence) if the queue is empty or the head chunk is too short
   * to provide a complete sample.
   */
  #nextSample(bytesPerSample) {
    while (this.#queue.length > 0) {
      const head = this.#queue[0];

      if (this.#offset + bytesPerSample <= head.byteLength) {
        // Enough bytes remaining in this chunk.
        const view = new DataView(
          head.buffer,
          head.byteOffset + this.#offset,
          bytesPerSample
        );
        this.#offset += bytesPerSample;
        if (this.#offset >= head.byteLength) {
          this.#queue.shift();
          this.#offset = 0;
        }
        return this.#decodeSample(view, bytesPerSample);
      }

      // Chunk exhausted or too short for a complete sample — discard it.
      this.#queue.shift();
      this.#offset = 0;
    }

    return 0; // silence
  }

  /**
   * Decode a sample from a DataView at offset 0.
   * All multi-byte formats are read as big-endian to match m68k Mac byte order.
   */
  #decodeSample(view, bytesPerSample) {
    switch (bytesPerSample) {
      case 4:
        // 32-bit float — big-endian (rare on classic Mac but handle it).
        return view.getFloat32(0, false);
      case 2:
        // 16-bit signed integer — big-endian. Normalise to [-1, +1].
        return view.getInt16(0, false) / 0x8000;
      case 1:
        // 8-bit signed integer. Normalise to [-1, +1].
        return view.getInt8(0) / 0x80;
      default:
        return 0;
    }
  }
}

registerProcessor("cvm-audio-processor", CvmAudioProcessor);

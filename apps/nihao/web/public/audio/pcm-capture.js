/** Streaming area resampling keeps fractional sample positions across render blocks. */
export class PcmPacketizer {
  constructor(sourceRate, onPacket, packetSamples = 3200) {
    if (!Number.isFinite(sourceRate) || sourceRate < 16000 || sourceRate > 192000) throw new Error('Unsupported sample rate');
    this.ratio = sourceRate / 16000;
    this.onPacket = onPacket;
    this.packetSamples = packetSamples;
    this.packet = new ArrayBuffer(packetSamples * 2);
    this.view = new DataView(this.packet);
    this.count = 0;
    this.sum = 0;
    this.weight = 0;
  }

  push(samples) {
    for (const raw of samples) {
      const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      let unused = 1;
      while (unused > 1e-9) {
        const take = Math.min(unused, this.ratio - this.weight);
        this.sum += value * take;
        this.weight += take;
        unused -= take;
        if (this.weight >= this.ratio - 1e-9) {
          this.emit(this.sum / this.weight);
          this.sum = 0;
          this.weight = 0;
        }
      }
    }
  }

  emit(sample) {
    this.view.setInt16(this.count * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    if (++this.count === this.packetSamples) this.send();
  }

  send() {
    if (!this.count) return;
    this.onPacket(this.count === this.packetSamples ? this.packet : this.packet.slice(0, this.count * 2));
    this.packet = new ArrayBuffer(this.packetSamples * 2);
    this.view = new DataView(this.packet);
    this.count = 0;
  }

  flush() {
    if (this.weight > 1e-9) this.emit(this.sum / this.weight);
    this.sum = 0;
    this.weight = 0;
    this.send();
  }
}

// The export above is also exercised directly by DSP tests without an AudioWorklet host.
if (typeof registerProcessor === 'function') {
  class NihaoPcmCapture extends AudioWorkletProcessor {
    constructor() {
      super();
      this.stopped = false;
      this.meterSamples = 0;
      this.meterEnergy = 0;
      this.packetizer = new PcmPacketizer(sampleRate, pcm => this.port.postMessage({ type: 'pcm', pcm }, [pcm]));
      this.port.onmessage = event => {
        if (event.data?.type !== 'flush' || this.stopped) return;
        this.stopped = true;
        this.packetizer.flush();
        this.port.postMessage({ type: 'flushed' });
      };
    }

    process(inputs) {
      const channels = inputs[0];
      if (this.stopped) return false;
      if (!channels?.length || !channels[0]?.length) return true;
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels) {
        for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
      }
      this.packetizer.push(mono);
      for (const value of mono) this.meterEnergy += value * value;
      this.meterSamples += mono.length;
      if (this.meterSamples >= sampleRate / 10) {
        this.port.postMessage({ type: 'level', level: Math.sqrt(this.meterEnergy / this.meterSamples) });
        this.meterSamples = 0;
        this.meterEnergy = 0;
      }
      // Outputs remain zero: microphone audio is never played through the speakers.
      return true;
    }
  }
  registerProcessor('nihao-pcm-capture', NihaoPcmCapture);
}

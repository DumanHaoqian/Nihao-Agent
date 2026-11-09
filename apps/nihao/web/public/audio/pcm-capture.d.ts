export class PcmPacketizer {
  constructor(sourceRate: number, onPacket: (packet: ArrayBuffer) => void, packetSamples?: number);
  push(samples: Float32Array): void;
  flush(): void;
}

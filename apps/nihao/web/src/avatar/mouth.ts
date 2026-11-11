export type Mouth = 'closed' | 'slight_open' | 'medium_open' | 'wide_open';
const mouths: Mouth[] = ['closed', 'slight_open', 'medium_open', 'wide_open'];
/** Volume envelope, not phonemes. Time-based smoothing and hysteresis avoid chatter. */
export class MouthEnvelope {
  private level = 0;
  private index = 0;
  reset(): Mouth { this.level = 0; this.index = 0; return 'closed'; }
  sample(rms: number, elapsedMs: number): Mouth {
    if (!Number.isFinite(rms) || rms < .006) return this.reset();
    const alpha = 1 - Math.exp(-Math.max(0, Math.min(100, elapsedMs)) / (rms > this.level ? 35 : 65));
    this.level += (rms - this.level) * alpha;
    const up = [.012, .05, .12], down = [.008, .035, .09];
    while (this.index < 3 && this.level >= up[this.index]!) this.index++;
    while (this.index > 0 && this.level < down[this.index - 1]!) this.index--;
    return mouths[this.index]!;
  }
}

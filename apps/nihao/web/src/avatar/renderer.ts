import type { AvatarAssets, Clip } from './assets.ts';
import type { AvatarView } from './controller.ts';
import type { Mouth } from './mouth.ts';

export function shouldAnimate(active: boolean, visible: boolean, hidden: boolean, reduced: boolean): boolean {
  return active && visible && !hidden && !reduced;
}
export function frameAt(clip: Clip, elapsed: number) {
  let remaining = Math.max(0, elapsed);
  for (const frame of clip.frames) {
    if (remaining < frame.durationMs) return frame;
    remaining -= frame.durationMs;
  }
  return clip.frames.at(-1)!;
}

/** All layers share one fixed crop. Hair is deliberately composited AFTER the face. */
export function drawAvatar(ctx: CanvasRenderingContext2D, assets: AvatarAssets, view: AvatarView, mouth: Mouth, now: number, animate: boolean, clip?: { definition: Clip; image: HTMLImageElement; elapsed: number }) {
  const { entry, base, front, sheet } = assets;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, entry.width, entry.height);
  if (clip && animate) {
    const frame = frameAt(clip.definition, clip.elapsed);
    ctx.drawImage(clip.image, frame.x, frame.y, frame.w, frame.h, 0, 0, entry.width, entry.height);
    return;
  }
  const dy = animate && view.activity === 'idle' && view.expression === 'neutral' ? Math.round(Math.sin(now / 1800) * .65) : 0;
  ctx.save();
  ctx.translate(0, dy);
  ctx.drawImage(base, 0, 0);
  const blink = animate && now % 5200 > 5050;
  const eyes = blink ? 'closed' : view.expression === 'thinking' ? 'half_closed' : 'open';
  const eyebrows = view.expression === 'neutral' ? 'neutral' : 'concerned';
  const actualMouth = view.activity === 'speaking' && animate ? mouth : view.expression === 'concerned' ? 'downturned' : 'closed';
  for (const name of [`eyes_${eyes}`, `eyebrows_${eyebrows}`, `mouth_${actualMouth}`]) {
    const rect = entry.features[name]!;
    ctx.drawImage(sheet, rect.x, rect.y, rect.w, rect.h, 0, 0, entry.width, entry.height);
  }
  ctx.drawImage(front, 0, 0);
  ctx.restore();
}

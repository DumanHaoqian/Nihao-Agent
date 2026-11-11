export type Framing = 'portrait' | 'bust';
export interface Rect { x: number; y: number; w: number; h: number }
export interface Clip { file: string; frames: (Rect & { durationMs: number })[] }
export interface AssetEntry {
  width: number; height: number; base: string; front: string; sheet: string; static: string;
  features: Record<string, Rect>; clips: Partial<Record<'waving' | 'nodding', Clip>>;
}
export interface AvatarAssets { entry: AssetEntry; base: HTMLImageElement; front: HTMLImageElement; sheet: HTMLImageElement }
export const ASSET_ROOT = '/avatar/nihao-v1/';
const images = new Map<string, Promise<HTMLImageElement>>();
const bundles = new Map<Framing, Promise<AvatarAssets>>();
let manifest: Promise<{ version: number; framings: Record<Framing, AssetEntry> }> | undefined;
export function loadImage(file: string): Promise<HTMLImageElement> {
  if (!/^(portrait|bust)\/[a-z-]+\.png$/.test(file)) return Promise.reject(new Error('Invalid avatar asset'));
  let pending = images.get(file);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const image = new Image();
      const timer = setTimeout(() => { image.onload = image.onerror = null; reject(new Error('Avatar image timed out')); }, 8000);
      image.onload = () => { clearTimeout(timer); image.onload = image.onerror = null; resolve(image); };
      image.onerror = () => { clearTimeout(timer); image.onload = image.onerror = null; reject(new Error('Avatar image unavailable')); };
      image.src = ASSET_ROOT + file;
    });
    images.set(file, pending);
  }
  return pending;
}
export function loadAvatar(framing: Framing): Promise<AvatarAssets> {
  let pending = bundles.get(framing);
  if (!pending) {
    manifest ??= fetch(`${ASSET_ROOT}manifest.json`, { signal: AbortSignal.timeout(8000) }).then(async response => {
      if (!response.ok) throw new Error('Avatar manifest unavailable');
      const data = await response.json();
      if (data.version !== 1) throw new Error('Unsupported avatar');
      return data;
    });
    pending = manifest.then(async data => {
      const entry = data.framings[framing];
      if (!entry || entry.width > 256 || entry.height > 256) throw new Error('Invalid framing');
      const [base, front, sheet] = await Promise.all([loadImage(entry.base), loadImage(entry.front), loadImage(entry.sheet)]);
      return { entry, base, front, sheet };
    });
    bundles.set(framing, pending);
  }
  return pending;
}

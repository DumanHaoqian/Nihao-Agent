import sharp from 'sharp';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Deterministic registered crops of existing artwork. No generated art or hashes.
const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'assets/avatar/nihao-avatar-pack-v1');
const output = join(root, 'apps/nihao/web/public/avatar/nihao-v1');
const master = JSON.parse(await readFile(join(source, 'meta/manifest.json'), 'utf8'));
const windows = {
  portrait: { left: 128, top: 16, width: 768, height: 768, size: [128, 128] },
  bust: { left: 128, top: 16, width: 768, height: 1024, size: [192, 256] },
  full: { left: 0, top: 0, width: 1024, height: 1536, size: [128, 192] },
};
const clear = { r: 0, g: 0, b: 0, alpha: 0 };
const canvas = () => sharp({ create: { width: 1024, height: 1536, channels: 4, background: clear } });
const layers = master.layers.filter(layer => layer.visible !== false && layer.default !== false).sort((a, b) => a.z - b.z);
const flatten = selected => canvas().composite(selected.map(layer => ({ input: join(source, layer.file) }))).png().toBuffer();
const foreground = layers.filter(layer => !layer.group && layer.z >= 50);
const base = layers.filter(layer => !layer.group && layer.z < 50);
const features = layers.filter(layer => ['eyes_open', 'eyes_half_closed', 'eyes_closed', 'eyebrows_neutral', 'eyebrows_concerned', 'mouth_closed', 'mouth_slight_open', 'mouth_medium_open', 'mouth_wide_open', 'mouth_downturned'].includes(layer.id));
const manifest = { version: 1, sourceCanvas: master.canvas, framings: {} };
const files = [];
for (const [framing, window] of Object.entries(windows)) {
  const { size: [width, height], ...crop } = window;
  const dir = join(output, framing);
  await mkdir(dir, { recursive: true });
  const resize = input => sharp(input).extract(crop).resize(width, height, { kernel: 'nearest' }).png().toBuffer();
  const save = async (name, input) => { const path = join(dir, name); await writeFile(path, input); files.push(path); return `${framing}/${name}`; };
  const entry = { width, height, crop, static: await save('static.png', await resize(join(source, master.expressions.neutral.file))) };
  if (framing !== 'full') {
    entry.base = await save('base.png', await resize(await flatten(base)));
    entry.front = await save('front.png', await resize(await flatten(foreground)));
    entry.features = {};
    const featureImages = [];
    for (let i = 0; i < features.length; i++) {
      const x = i % 5 * width, y = Math.floor(i / 5) * height;
      featureImages.push({ input: await resize(join(source, features[i].file)), left: x, top: y });
      entry.features[features[i].id] = { x, y, w: width, h: height };
    }
    entry.sheet = await save('features.png', await sharp({ create: { width: width * 5, height: height * 2, channels: 4, background: clear } }).composite(featureImages).png().toBuffer());
    entry.clips = {};
    for (const kind of framing === 'bust' ? ['waving', 'nodding'] : ['nodding']) {
      const clip = master.animations[kind];
      const images = [], frames = [];
      for (let i = 0; i < clip.frames.length; i++) {
        const x = i % 4 * width, y = Math.floor(i / 4) * height;
        images.push({ input: await resize(join(source, clip.frames[i].file)), left: x, top: y });
        frames.push({ x, y, w: width, h: height, durationMs: clip.frames[i].durationMs });
      }
      entry.clips[kind] = { file: await save(`${kind}.png`, await sharp({ create: { width: width * 4, height: height * Math.ceil(images.length / 4), channels: 4, background: clear } }).composite(images).png().toBuffer()), frames };
    }
  }
  manifest.framings[framing] = entry;
}
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest));
console.log(`Prepared ${files.length} registered PNGs, ${Math.round((await Promise.all(files.map(file => stat(file)))).reduce((n, s) => n + s.size, 0) / 1024)} KiB; original artwork unchanged.`);

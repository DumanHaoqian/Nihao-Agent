/* Nihao Agent avatar preview — no framework or third-party runtime dependency. */
const $ = (id) => document.getElementById(id);
const canvas = $('avatar');
const ctx = canvas.getContext('2d');
const root = new URL('../', import.meta.url);
const cache = new Map();
const labels = {
  idle: '待机', idle_loop: '待机循环', blink: '眨眼', talking: '说话', talk: '说话',
  talking_mouth: '说话嘴型', talking_mouth_set: '说话嘴型', waving: '挥手', wave: '挥手', nod: '点头', nodding: '点头',
  neutral: '自然', happy: '开心', excited: '兴奋', thinking: '思考', concerned: '关切', apologetic: '抱歉',
  idle_pose: '自然站立', waving_pose: '招手', pointing_left: '指向左侧', pointing_right: '指向右侧',
  explaining: '讲解', explaining_pose: '讲解', hands_together_welcome: '合手欢迎', hands_together_welcome_pose: '合手欢迎',
  welcome: '欢迎', celebration: '庆祝', celebration_pose: '庆祝',
};
const state = {
  manifest: null, mode: 'animation', name: '', expression: 'neutral', frames: [], images: [],
  frame: 0, elapsed: 0, playing: false, loop: false, speed: 1, angle: 0, token: 0,
  visibility: new Map(), composite: [], lastTimestamp: null,
};
function label(name) { return labels[name] || labels[name.replace(/^pose_/, '')] || name.replaceAll('_', ' '); }
function entries(value) {
  if (Array.isArray(value)) return value.map((v, i) => [v.name || v.id || String(i), v]);
  return Object.entries(value || {});
}
function fileOf(value) { return typeof value === 'string' ? value : value?.file || value?.path || value?.src; }
function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); }
function loadImage(file) {
  if (!file) return Promise.reject(new Error('清单中缺少图片路径'));
  if (!cache.has(file)) cache.set(file, new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`图片无法加载：${file}`));
    image.src = new URL(file, root).href;
  }));
  return cache.get(file);
}
function normalizeFrames(animation) {
  const fallback = animation?.frameDurationMs || (animation?.fps ? 1000 / animation.fps : 100);
  return (Array.isArray(animation) ? animation : animation?.frames || []).map((frame) => ({
    file: fileOf(frame), durationMs: Math.max(16, Number(frame?.durationMs || frame?.duration || fallback)),
  }));
}
function feature(layer) {
  const group = layer.group || layer.category;
  if (['eyes', 'eyebrows', 'mouth'].includes(group)) return { group, value: layer.state || layer.variant };
  const match = layer.id?.match(/(?:^|_)(eyes|eyebrows|mouth)_(.+)$/);
  return match ? { group: match[1], value: match[2] } : null;
}
function chosenLayers() {
  const expression = state.manifest.expressions?.[state.expression] || {};
  const choices = { eyes: 'open', eyebrows: 'neutral', mouth: 'closed', ...expression };
  return (state.manifest.layers || []).filter((layer) => {
    if (state.visibility.get(layer.id) === false) return false;
    const variant = feature(layer);
    if (variant) return variant.value === choices[variant.group];
    return layer.visible !== false && layer.default !== false;
  }).sort((a, b) => (a.z || 0) - (b.z || 0));
}
function isHeadLayer(layer) {
  if (layer.parent === 'head' || layer.group === 'head') return true;
  let parent = layer.parent;
  const seen = new Set();
  while (parent && !seen.has(parent)) {
    if (parent === 'head') return true;
    seen.add(parent);
    parent = state.manifest.layers.find((item) => item.id === parent)?.parent;
  }
  return /^(?:face|hair|side_hair|bun|ribbon|eyes|eyebrows|mouth)/.test(layer.id);
}
function headPivot() {
  const m = state.manifest;
  const found = m.anchors?.head || m.anchors?.neck || m.rig?.head?.pivot || m.layers.find((layer) => layer.id === 'head')?.pivot;
  if (Array.isArray(found)) return found;
  if (found && Number.isFinite(found.x)) return [found.x, found.y];
  return [canvas.width / 2, canvas.height * .49];
}
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  if (state.mode === 'layers') {
    const pivot = headPivot();
    for (const { layer, image } of state.composite) {
      ctx.save();
      if (state.angle && isHeadLayer(layer)) {
        ctx.translate(pivot[0], pivot[1]); ctx.rotate(state.angle * Math.PI / 180); ctx.translate(-pivot[0], -pivot[1]);
      }
      // Files are full-size aligned layers. Optional x/y supports explicitly trimmed assets.
      ctx.drawImage(image, layer.x || 0, layer.y || 0);
      ctx.restore();
    }
  } else {
    const image = state.images[state.frame];
    if (image) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  $('timeline').value = state.frame;
  $('frame-label').textContent = state.frames.length ? `${state.frame + 1} / ${state.frames.length}` : '分层组合';
}
function syncControls() {
  $('play').textContent = state.playing ? '暂停' : '播放';
  const moving = state.frames.length > 1 && state.mode !== 'layers';
  $('play').disabled = !moving; $('restart').disabled = !moving; $('timeline').disabled = !moving;
  $('timeline').max = Math.max(0, state.frames.length - 1);
  $('loop').checked = state.loop;
  $('loop').disabled = !moving;
  $('layer-mode').setAttribute('aria-pressed', String(state.mode === 'layers'));
  document.querySelectorAll('button[data-mode]').forEach((button) => {
    const selected = button.dataset.mode === state.mode && button.dataset.name === state.name;
    const activeExpression = state.mode === 'layers' && button.dataset.mode === 'expression' && button.dataset.name === state.expression;
    button.setAttribute('aria-pressed', String(selected || activeExpression));
  });
}
async function compose() {
  const token = ++state.token;
  state.playing = false; state.frames = []; state.images = []; state.frame = 0;
  const layers = chosenLayers();
  try {
    const composite = await Promise.all(layers.map(async (layer) => ({ layer, image: await loadImage(fileOf(layer)) })));
    if (token !== state.token) return;
    state.composite = composite;
    $('selection-label').textContent = `分层组合 · ${label(state.expression)}`;
    status(`${layers.length} 个图层 · ${canvas.width} × ${canvas.height} · 头部锚点 ${headPivot().join(', ')}`);
    syncControls(); draw();
  } catch (error) { if (token === state.token) status(error.message, true); }
}
async function select(mode, name) {
  if (mode === 'layers') { state.mode = mode; await compose(); return; }
  if (mode === 'expression') {
    state.expression = name;
    if (state.mode === 'layers') { await compose(); return; }
  }
  const collection = state.manifest[mode === 'animation' ? 'animations' : mode === 'expression' ? 'expressions' : 'poses'];
  const item = entries(collection).find(([key]) => key === name)?.[1];
  if (!item) return;
  if (mode === 'expression' && !fileOf(item)) { state.mode = 'layers'; await compose(); return; }
  const token = ++state.token;
  state.mode = mode; state.name = name; state.playing = false; state.frame = 0; state.elapsed = 0;
  const frames = mode === 'animation' ? normalizeFrames(item) : [{ file: fileOf(item), durationMs: 1000 }];
  if (!frames.length) { status(`动画 ${name} 尚未声明帧。`, true); return; }
  status(`加载 ${label(name)}…`);
  try {
    const images = await Promise.all(frames.map((frame) => loadImage(frame.file)));
    if (token !== state.token) return;
    state.frames = frames; state.images = images; state.loop = mode === 'animation' && item.loop === true;
    state.playing = frames.length > 1;
    $('selection-label').textContent = `${mode === 'animation' ? '动画' : mode === 'expression' ? '表情' : '姿态'} · ${label(name)}`;
    const duration = frames.reduce((sum, frame) => sum + frame.durationMs, 0);
    status(`${frames.length} 张透明 PNG · ${canvas.width} × ${canvas.height}${frames.length > 1 ? ` · ${(duration / 1000).toFixed(2)} 秒 / 遍` : ''}`);
    syncControls(); draw();
  } catch (error) { if (token === state.token) { state.playing = false; status(error.message, true); syncControls(); } }
}
function addButtons(containerId, mode, collection) {
  const container = $(containerId);
  const items = entries(collection);
  if (!items.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '清单中暂无此类资产'; container.append(empty); }
  for (const [name, item] of items) {
    const button = document.createElement('button'); button.className = 'chip';
    button.textContent = item.label || label(name); button.dataset.mode = mode; button.dataset.name = name;
    button.setAttribute('aria-pressed', 'false'); button.addEventListener('click', () => select(mode, name)); container.append(button);
  }
}
function tick(timestamp) {
  const delta = state.lastTimestamp === null ? 0 : Math.min(timestamp - state.lastTimestamp, 250);
  state.lastTimestamp = timestamp;
  if (state.playing && state.frames.length > 1 && state.mode !== 'layers') {
    state.elapsed += delta * state.speed;
    let changed = false;
    while (state.elapsed >= state.frames[state.frame].durationMs) {
      state.elapsed -= state.frames[state.frame].durationMs;
      if (state.frame + 1 < state.frames.length) state.frame++;
      else if (state.loop) state.frame = 0;
      else { state.playing = false; state.elapsed = 0; syncControls(); break; }
      changed = true;
    }
    if (changed) draw();
  }
  requestAnimationFrame(tick);
}
$('play').addEventListener('click', () => {
  if (!state.playing && state.frame === state.frames.length - 1) { state.frame = 0; state.elapsed = 0; }
  state.playing = !state.playing; syncControls(); draw();
});
$('restart').addEventListener('click', () => { state.frame = 0; state.elapsed = 0; state.playing = true; syncControls(); draw(); });
$('timeline').addEventListener('input', (event) => { state.frame = Number(event.target.value); state.elapsed = 0; state.playing = false; syncControls(); draw(); });
$('loop').addEventListener('change', (event) => { state.loop = event.target.checked; });
$('speed').addEventListener('input', (event) => { state.speed = Number(event.target.value); $('speed-value').textContent = `${state.speed}×`; });
$('layer-mode').addEventListener('click', () => select('layers', ''));
$('head-angle').addEventListener('input', async (event) => {
  state.angle = Number(event.target.value); $('head-angle-value').textContent = `${state.angle}°`;
  if (state.mode !== 'layers') await select('layers', ''); else draw();
});
document.querySelectorAll('button[data-bg]').forEach((button) => button.addEventListener('click', () => {
  $('stage').dataset.background = button.dataset.bg;
  document.querySelectorAll('button[data-bg]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
}));
async function init() {
  try {
    const response = await fetch(new URL('manifest.json', import.meta.url));
    if (!response.ok) throw new Error(`manifest.json 返回 HTTP ${response.status}`);
    state.manifest = await response.json();
    const m = state.manifest;
    canvas.width = m.canvas?.width || 1024; canvas.height = m.canvas?.height || 1536;
    m.layers ||= [];
    addButtons('animation-buttons', 'animation', m.animations);
    addButtons('expression-buttons', 'expression', m.expressions);
    addButtons('pose-buttons', 'pose', m.poses);
    const list = $('layer-list');
    for (const layer of m.layers) {
      const row = document.createElement('label'); const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = true; input.addEventListener('change', async () => { state.visibility.set(layer.id, input.checked); await select('layers', ''); });
      row.append(input, document.createTextNode(layer.id)); list.append(row);
    }
    $('asset-summary').textContent = `${m.layers.length} 个图层 · ${entries(m.expressions).length} 种表情 · ${entries(m.animations).length} 组动画。所有路径均来自 manifest。`;
    const animationNames = entries(m.animations).map(([name]) => name);
    const expressionNames = entries(m.expressions).map(([name]) => name);
    state.expression = expressionNames.includes('neutral') ? 'neutral' : expressionNames[0] || 'neutral';
    if (animationNames.length) await select('animation', animationNames.find((name) => /^idle/.test(name)) || animationNames[0]);
    else if (expressionNames.length) await select('expression', state.expression);
    else await select('layers', '');
    requestAnimationFrame(tick);
  } catch (error) {
    status(`${error.message}。请通过本地 HTTP 服务打开此页面，不要直接双击 file:// 文件；启动方法见 INTEGRATION.md。`, true);
  }
}
init();

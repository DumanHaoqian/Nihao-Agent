import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ASSET_ROOT, loadAvatar, loadImage, type AvatarAssets, type Framing } from '../avatar/assets.ts';
import { STATIC_AVATAR, type AvatarView } from '../avatar/controller.ts';
import { MouthEnvelope } from '../avatar/mouth.ts';
import { drawAvatar, shouldAnimate } from '../avatar/renderer.ts';

const silent = () => 0;
interface Props { framing?: Framing; state?: AvatarView; readLevel?: () => number; label: string }

/** Historical messages are plain images. Only the selected owner mounts a Canvas loop. */
export function NihaoAvatar({ framing = 'portrait', state = STATIC_AVATAR, readLevel = silent, label }: Props) {
  const [failed, setFailed] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLSpanElement>(null);
  const latest = useRef({ state, readLevel });
  latest.current = { state, readLevel };
  const refresh = useRef<(() => void) | undefined>(undefined);
  const active = Boolean(state.target);
  useLayoutEffect(() => { refresh.current?.(); }, [state, readLevel]);
  useEffect(() => {
    const element = canvas.current;
    const container = host.current;
    if (!active || failed || !element || !container) return;
    const ctx = element.getContext('2d');
    if (!ctx || typeof IntersectionObserver === 'undefined') { setFailed(true); return; }
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false, visible = false, loading = false, frame = 0, previousTime = 0;
    let assets: AvatarAssets | undefined;
    let suppressedAction: string | undefined;
    const clips = new Map<string, HTMLImageElement>();
    const pendingClips = new Set<string>();
    const mouth = new MouthEnvelope();
    function pause() {
      cancelAnimationFrame(frame); frame = 0; previousTime = 0;
      suppressedAction = latest.current.state.action?.id;
      mouth.reset();
      element!.dataset.mouth = 'closed';
      element!.dataset.animating = 'false';
      if (assets) drawAvatar(ctx!, assets, latest.current.state, 'closed', performance.now(), false);
    }
    function fail() { if (!disposed) { pause(); setFailed(true); } }
    function draw(now: number) {
      frame = 0;
      if (disposed || !visible || document.hidden) { pause(); return; }
      if (!assets) {
        if (!loading) {
          loading = true;
          void loadAvatar(framing).then(value => {
            if (disposed) return;
            assets = value;
            element!.width = value.entry.width; element!.height = value.entry.height;
            wake();
          }).catch(fail);
        }
        return;
      }
      const { state: current, readLevel: level } = latest.current;
      const animate = shouldAnimate(active, visible, document.hidden, media.matches);
      const elapsed = previousTime ? now - previousTime : 33;
      previousTime = now;
      const shape = current.activity === 'speaking' && animate ? mouth.sample(level(), elapsed) : mouth.reset();
      let kind: 'waving' | 'nodding' | undefined, clipTime = 0;
      if (animate && current.action && current.action.id !== suppressedAction && now < current.action.startedAt + current.action.duration) {
        kind = current.action.kind; clipTime = now - current.action.startedAt;
      } else if (animate && current.activity === 'listening' && now % 6500 < 1080) { kind = 'nodding'; clipTime = now % 6500; }
      const definition = kind ? assets.entry.clips[kind] : undefined;
      if (definition && !clips.has(definition.file) && !pendingClips.has(definition.file)) {
        pendingClips.add(definition.file);
        void loadImage(definition.file).then(image => { if (!disposed) { clips.set(definition.file, image); wake(); } }).catch(fail);
      }
      const image = definition && clips.get(definition.file);
      drawAvatar(ctx!, assets, current, shape, now, animate, definition && image ? { definition, image, elapsed: clipTime } : undefined);
      element!.dataset.mouth = shape;
      element!.dataset.animating = String(animate);
      element!.dataset.draws = String(Number(element!.dataset.draws ?? 0) + 1);
      element!.dataset.clip = definition && image ? kind : '';
      element!.style.visibility = 'visible';
      container!.dataset.ready = 'true';
      if (animate) frame = requestAnimationFrame(tick);
    }
    function tick(now: number) {
      if (disposed || !visible || document.hidden || media.matches) { pause(); return; }
      // Limit pixel animation to 30fps without scheduling per-frame React updates.
      if (now - previousTime < 32) { frame = requestAnimationFrame(tick); return; }
      draw(now);
    }
    function wake() {
      cancelAnimationFrame(frame); frame = 0;
      if (!disposed) draw(performance.now());
    }
    function visibility() {
      if (document.hidden || !visible || media.matches) pause();
      // Skip actions that started while hidden; never replay a visual backlog.
      suppressedAction = latest.current.state.action?.id;
      wake();
    }
    const observer = new IntersectionObserver(entries => {
      const next = entries[0]?.isIntersecting ?? false;
      if (!next) pause();
      else if (!visible && loading) suppressedAction = latest.current.state.action?.id;
      visible = next;
      wake();
    });
    observer.observe(container);
    media.addEventListener('change', visibility);
    document.addEventListener('visibilitychange', visibility);
    refresh.current = wake;
    return () => {
      disposed = true;
      pause(); observer.disconnect();
      media.removeEventListener('change', visibility);
      document.removeEventListener('visibilitychange', visibility);
      refresh.current = undefined;
      delete container.dataset.ready;
    };
  }, [active, framing, failed]);

  return <span ref={host} className={`nihao-avatar nihao-avatar--${framing}`} role="img" aria-label={label} data-owner={state.messageId ?? state.target ?? 'history'} data-activity={state.activity} data-expression={state.expression} data-action={state.action?.id ?? ''} data-fallback={failed}>
    <img src={failed ? '/brand/chat-head.png' : `${ASSET_ROOT}${framing}/static.png`} alt="" width={framing === 'portrait' ? 128 : 192} height={framing === 'portrait' ? 128 : 256} onError={() => { if (!failed) setFailed(true); }} />
    {active && !failed && <canvas ref={canvas} aria-hidden="true" data-mouth="closed" />}
  </span>;
}

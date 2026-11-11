# Nihao character runtime

The application uses the existing pixel-art character through React and Canvas 2D. No new character images, backpacks, model-generated expressions, or Harness loop changes are involved. The original artwork remains in `assets/avatar/nihao-avatar-pack-v1/`.

## Ownership and state

`avatar/controller.ts` selects one visible owner: the welcome character, one reply identified by its message ID, or the compact dictation companion above the composer. Activity, expression and one-shot action are separate fields. The controller consumes welcome, completed travel and completed speech event IDs once; there is no deferred action queue. A conversation epoch rejects old callbacks after New chat. Canvas remounts do not create new actions.

Actual speech sessions take priority over pending text. Reading an older reply while a newer one streams selects the older reply's avatar. The existing behavior of stopping playback when submitting a new message is unchanged; the user can then explicitly read an older reply while generation continues. Dictation and read aloud remain mutually exclusive.

- First welcome: one wave, then subtle idle movement and occasional blinking.
- Waiting for text or a running map tool: thinking, closed mouth.
- Text deltas: neutral, closed mouth.
- Preparing speech, microphone permission/connection and ASR finalization: neutral waiting.
- Actual recording: listening with an occasional nod, closed mouth.
- Successful completed turn with validated travel artifacts: one short nod. Individual tool completion does not trigger success.
- Request failure: concerned. Voluntary cancellation: neutral.
- Historical replies: static images, no Canvas or animation loops.

The character supplements existing status text, errors and controls. It does not infer emotions or factual confidence from generated prose.

## Audio-driven mouth

`StreamingPcmPlayer` owns one analyser per playback session:

```text
scheduled PCM sources → shared AnalyserNode → destination
                       ↓
                stable readLevel()
                       ↓
          RMS envelope + hysteresis → Canvas mouth layer
```

`readLevel()` reads time-domain samples only during a source's actual scheduled interval. Before playback, between network blocks, after stop and after the last source ends, it returns zero. The existing `finish()` still waits for all queued sources' `onended` events. Replay uses the same player. Stop, errors, New chat and unmount disconnect sources and the analyser.

The renderer smooths the RMS level into closed, slight, medium and wide mouth states. Silence resets the envelope immediately. Audio samples travel through a stable callback/ref, never per-frame React state. There are no phoneme timestamps: this is **volume-synchronized mouth animation, not precise lip sync**. The O-shaped mouth is intentionally unused.

## Lightweight assets

Run `npm run prepare:avatar` from the repository root to regenerate checked-in assets using `sharp`. It only reads existing PNGs and writes the selected runtime files in `apps/nihao/web/public/avatar/nihao-v1/`. It does not run the original art-pack rebuilding or validation scripts.

| Framing | Fixed master crop (x, y, width, height) | Export size | Use |
| --- | --- | --- | --- |
| portrait | 128, 16, 768, 768 | 128 × 128 | 48px chat avatar, compact dictation companion |
| bust | 128, 16, 768, 1024 | 192 × 256 | 176px welcome character; 144px on mobile |
| full | 0, 0, 1024, 1536 | 128 × 192 | Static reference only; not loaded by the UI |

Twelve PNGs plus the compact manifest total 88,508 bytes in this version. The original source pack, prompts and QA imagery are not copied into `public/`. Core images are shared and loaded only for the active, visible framing; waving/nodding atlases are requested when used. No full-resolution animation frames are decoded in the browser.

The speaking composition is a mouth-free base, one eye layer, one eyebrow layer, one mouth layer, then front hair/ribbon/side hair. All layers and clips use the same crop and offsets. Exports use nearest-neighbor resampling and retain transparency; Canvas smoothing is off.

## Lifecycle and accessibility

Only the selected owner schedules a visual loop, capped at approximately 30fps. IntersectionObserver pauses offscreen drawing; document visibility pauses background drawing. Recovery reads current state and discards interrupted one-shot actions instead of replaying them. Neither changes audio playback. `prefers-reduced-motion` disables the JS animation loop, including moving mouths; a static expression and existing status text remain available.

Image failures, manifest failures or unavailable Canvas/IntersectionObserver fall back to `/brand/chat-head.png`. Cache loads are shared, bounded by timeouts and cannot restore old business state. Component cleanup cancels RAF and removes observers/media/visibility listeners. Every action timer is scoped to its conversation epoch and action ID.

## Design and verification

The existing layout and branding remain. The red/gold pixel character is the main visual detail; no new panels, decorative icons or large virtual-human surface were added. Welcome spacing is reduced to keep the composer within reach. On screens at or below 480px the secondary welcome description is hidden to preserve input space. The compact listening companion sits outside the recorder controls.

Reviewed before and after implementation against [unslop by Damir Sokolovsky](https://github.com/heydamir/unslop), CC BY 4.0. The requested pixel-art idle/blink loop and existing screenshot-inspired background are deliberate exceptions to its general motion and surface guidance.

```sh
npm run prepare:avatar
npm run typecheck
npm test
npm run build
npm run start:local
# In another terminal, with the app running:
npm run test:ui
npm run test:avatar:ui
```

The avatar browser test uses controlled chat/map/TTS responses with the real browser AudioContext and analyser. It checks sound/silence, scheduled gaps, replay, old-message ownership, tool progress, completed artifacts, cancellation, reduced motion, offscreen/background handling and corrupt-image fallback at desktop, 390px and 320px. The dictation regression uses a synthetic microphone through the real AudioWorklet path. These deterministic tests do not verify online Poe, Doubao or Baidu service availability. Screenshot evidence is written to `/tmp/nihao-avatar-*.png`, outside the source tree.

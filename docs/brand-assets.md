# Nihao Agent brand assets

## Sources and usage

Paths below are relative to the `Nihao-Agent/` project root.

- User source `assets/brand/logo-source.png`: horizontal Nihao Agent logo and blue N mark.
- User source `assets/avatar/chat-head.png`: character chat avatar, copied without changing its pixels.
- `assets/avatar/nihao-avatar-pack-v1/`: preserved source avatar material.
- `apps/nihao/web/public/brand/nihao-logo.png`: transparent horizontal logo, 832 × 186, displayed at 208px on desktop and up to 176px on mobile.
- `apps/nihao/web/public/brand/nihao-mark.png`: transparent blue N, 256 × 256, reusable brand asset.
- `apps/nihao/web/public/brand/nihao-icon.png`: 64 × 64 browser favicon.
- `apps/nihao/web/public/brand/chat-head.png`: original character image, displayed in a 48 × 48 box with its full silhouette and transparency preserved.

The built-in imagegen tool extracted the two logo assets. Sharp cropped the transparent padding and exported web sizes. Original source files were preserved under `assets/`; the browser continues to use the copies under `apps/nihao/web/public/brand/`. The avatar is the user's original PNG, not generated.

## Imagegen prompts

Horizontal logo: “Use case: background-extraction. Edit target: the supplied Nihao Agent brand sheet. Extract ONLY the large complete horizontal lockup in the TOP half: blue N symbol on left followed by the dark navy wordmark with bold Nihao and lighter Agent, exact text \"Nihao Agent\". Remove the entire pale textured background to true alpha transparency. Remove all three small variant icons in the bottom row. Preserve the source logo geometry, blue color, navy text, proportions, spacing, letter shapes, and texture precisely. This is a faithful cutout, not a redesign. Crop canvas tightly around the full top logo with just small even transparent padding; retain horizontal proportions. Crisp high resolution edges; no shadow, no outlines, no extra text. Output only the isolated horizontal logo on genuinely transparent background.”

Mark: “Use case: background-extraction. Asset type: website favicon and chat avatar. Extract ONLY the large BLUE N symbol at the upper left of the supplied brand sheet. Preserve its exact distinctive rounded folded N silhouette, blue fill and subtle texture; do not redesign. Remove all wordmark text and all three bottom variant icons. Remove the pale background to actual alpha transparency, including the open space within the N. Center the blue N on a tightly framed square transparent canvas with only 5% padding. Clean smooth antialiased edges with absolutely no isolated pixels, no speckles, no halos, no shadows, no outlines. This is a faithful cutout of the original brand mark, NOT a new logo.” The user subsequently chose the character PNG for chat, so the N is used for the favicon.

## Design review

Reviewed with [unslop by Damir Sokolovsky](https://github.com/heydamir/unslop), CC BY 4.0. This is a focused brand update to the existing screenshot-inspired layout.

- Product: a China travel chat assistant for international visitors.
- Character: calm, approachable, curious.
- World: travel and local conversation.
- Moments: blue N in the header; the user's red-clothed character at assistant replies.
- Signature: consistent original wordmark and character identity.

The existing spacing, neutral chat surfaces, typography, and controls remain. User-requested imagery takes priority over the skill's generic icon and wordmark preferences. Full wordmark and avatar keep their proportions without a tile, shadow, or animation. Header controls remain separate at 320px width. Checked image loading, favicon, header alignment, character avatar, and desktop/mobile layouts in Chrome using a mocked response for visual inspection; no model calls were needed for this asset change.

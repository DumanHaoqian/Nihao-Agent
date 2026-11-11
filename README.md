# Nihao Agent

A travel companion for international visitors to China, built from DeepSeek Harness. The browser uses React; the server runs the original Harness AgentLoop, accepts text and images, and streams Poe `gpt-5.4-mini` replies over SSE. Doubao provides microphone dictation with ASR 2.0 and read-aloud replies with TTS 2.0. Baidu Maps supplies place search, routes and itinerary cards in the conversation's language.

This directory is the repository and application root. The separate Python knowledge project lives in `knowledge/`; it is not yet connected to the chat application's answers.

## Run locally

Requires Node.js 24.9 or newer. Clone the repository, then run commands from its root:

```sh
git clone https://github.com/DumanHaoqian/Nihao-Agent.git
cd Nihao-Agent
```

For the existing local checkout, use `cd /Users/haoqian3/Desktop/Nihao-Agent` directly. Then:

```sh
npm install
npm run env:check:local
npm run build
npm run start:local
```

Open **http://127.0.0.1:8787**. The local launcher loads your existing zsh configuration and invokes the `poe`, `doubao` and `baidumap` aliases or functions when the corresponding variables are missing. They export `POE_API_KEY` for chat, `DOUBAO_API_KEY` for dictation/read aloud, and `BAIDU_MAP_API_KEY` for maps. Enable both streaming ASR 2.0 and TTS 2.0 in the key's Doubao project. The Baidu key must be a server-type AK with MCP service access. Values already present in the environment take priority. `npm run env:check:local` reports only whether each variable is loaded; it does not print the values or verify provider authorization. Credentials are not stored in this repository.

On another machine, copy `.env.example` to `.env`, fill in `POE_API_KEY`, `BAIDU_MAP_API_KEY` and `DOUBAO_API_KEY`, then run `npm run env:check`, `npm run build` and `npm start`. These commands work without zsh or shell aliases. `npm start` and `npm run dev` automatically load the root `.env`; exported environment variables take priority. The file is ignored by Git. The check prints presence only and exits nonzero for missing keys; it does not call providers. Restart after changing credentials. See [新电脑配置指南](docs/setup-new-computer.md).

For development, run `npm run dev:local` to load the same local shortcuts, or `npm run dev` with variables already exported. Open **http://127.0.0.1:5173**; Vite forwards `/api` to port 8787. Launchers enable Node's environment-proxy support for Poe; the Doubao WebSocket adapter separately respects `HTTPS_PROXY`/`HTTP_PROXY` and `NO_PROXY`.

## Current behavior

- English/中文 interface with a screenshot-inspired landing page and mobile layout.
- A pixel-art travel companion waves once on welcome, reacts to actual chat/map/dictation states, and animates only the selected reply. Read-aloud mouth movement follows actual output volume, including silent gaps and cached replay. Historical avatars stay static; reduced-motion and image fallback are supported. See [character runtime](docs/avatar-runtime.md).
- Markdown replies with bold, italics, lists, tables, code blocks and KaTeX formulas; real incremental replies, multi-turn context, stop, retry, copy and new chat.
- Upload or paste JPEG, PNG and WebP images, preview/remove them before sending, or send an image without text. Click a sent image to enlarge it. Completed image messages remain available to follow-up questions.
- Read aloud, stop and replay assistant replies. Doubao TTS 2.0 uses **Vivi 2.0** (`zh_female_vv_uranus_bigtts`) by default. Audio begins playing as PCM blocks arrive, before the entire reply has been synthesized. Playback starts only after clicking Read aloud.
- Click the microphone beside Send for Chinese/English voice input. Allow microphone access, speak, then click the checkmark to finish. Recognition updates the draft while you speak; you can edit it before sending. The cancel button or Escape restores the draft from before recording. Recordings are limited to two minutes, with a live volume display and timer.
- Enter sends; Shift+Enter inserts a newline; composing Chinese text does not accidentally send.
- Conversation state stays in the current browser tab's memory. Refreshing or starting a new chat clears it. Completed exchanges are included in follow-ups; interrupted replies are displayed but excluded from model history.
- Search actual places, compare walking/public-transport/driving routes, and create 1–3 day itineraries through Baidu Maps. Completed replies include place cards, route details and daily timelines with links to open Baidu Maps.
- Continue with requests such as “keep the same places but spend 45 minutes at each” to update the saved itinerary. Cancelled or failed turns do not replace the previous successful plan.
- Map cards follow the language of each assistant reply: names, addresses, opening-hours text, directions, notes, units and buttons use English or Chinese together. Changing the interface language does not rewrite older cards. The external Baidu website controls its own language.
- Each request gets an isolated in-memory Harness session and image attachment store. Only allowlisted map tools are mounted; there are no terminal, arbitrary file, general web browsing, booking or payment tools.

Choose up to 4 images per message (original files up to 20 MiB each). The browser normalizes images to JPEG, preserves aspect ratio, reduces the long edge to at most 2048 pixels and fills transparency with white. Each transmitted image is limited to 5 MiB; a conversation can contain up to 12 images and 20 MiB of decoded image data. Invalid images are reported before sending. The server validates and decodes image data again. Uploaded images stay in memory and are sent to Poe for inference; this application does not write them to disk.

Read aloud accepts up to 20,000 characters per request. Switching replies, sending a new message, stopping playback or starting a new chat cancels queued playback and the active synthesis request. The browser keeps only the last successfully played clip up to 8 MiB in memory; replaying that cached clip does not call Doubao again. New chat and page reload clear this cache. The app does not write speech audio to disk.

Dictation streams microphone audio to the local server and then to Doubao; it does not save a recording. Finishing stops microphone capture immediately while waiting for the final recognized words. New chat, cancellation and page exit release the microphone and close recognition. Starting dictation stops read aloud, and starting read aloud cancels dictation. A supported browser with microphone permission and AudioWorklet is required; localhost works as a secure context. This real-time endpoint supports Chinese and English; broader multilingual sentence recognition is a separate future integration.

The chat model accepts text and images. Dictation and read aloud are separate speech services, rather than audio capabilities of GPT-5.4-mini; see the [official model modalities](https://developers.openai.com/api/docs/models/gpt-5.4-mini). Audio/video file uploads are not supported. A future video-analysis workflow would need frame extraction and, when relevant, separate audio transcription.

The server binds to localhost. This MVP has no accounts or persistent history. Public deployment is a separate step requiring authentication and per-user usage controls.

## Maps and travel planning

Try: “Plan one day in Shanghai, visiting The Bund then Yu Garden on foot. Start at 09:00, spend 90 minutes at each, and finish before 17:00.” Follow up with “Make each visit 45 minutes” or ask for a transit route between the same places. Provide a hotel name when you want hotel departure and return included.

The backend connects lazily to Baidu's official Streamable HTTP MCP service. No MCP server needs to run on your machine. Poe selects app-owned tools through the existing Harness loop; validated map results feed both the next model step and structured UI events. AKs stay on the server, and navigation links contain no AK. An embedded JavaScript map would require a separate browser-type AK in a later iteration.

When map text needs translation, an additional streamed request through the existing Poe adapter translates only display strings after the main reply. An otherwise completed translation that fails validation can receive one bounded repair attempt, without repeating map lookups. The server protects numbers inside these strings and never lets translation change POI IDs, coordinates, distances, durations, stop order or navigation URLs. The original map facts stay in session memory. Translation failure produces a retryable error instead of publishing cards in the wrong language. Very large translation batches are bounded and may require a smaller request.

Plans support 1–3 days and up to six stops per day. The model proposes nearby places and their order; the program checks every travel leg using the selected mode, adds estimated visit durations and a configurable buffer, and rejects plans that exceed the chosen daily finish time. This is a time-budget check, not a global route optimizer. Opening hours, reservations and future traffic are not automatically verified. Meal/rest time must be included in stop durations or explicit stops. The UI distinguishes these limits from actual map results.

Verified places, routes and the latest itinerary live in a server-owned session with a random capability token, a two-hour idle lifetime and a maximum of 100 cached sessions. Refresh/New chat forgets the token; server restart clears all plans. Older inactive sessions may be evicted. Expiration is reported explicitly and retry starts a fresh map session. No itinerary data is written to disk by the app.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `POE_API_KEY` | Required for chat | Server-only Poe credential |
| `POE_MODEL` | `gpt-5.4-mini` | Exact Poe model ID |
| `POE_BASE_URL` | `https://api.poe.com/v1` | Poe-compatible API endpoint |
| `POE_MAX_TOKENS` | `4096` | Maximum reply tokens |
| `CHAT_TIMEOUT_MS` | `120000` | Overall request deadline |
| `CHAT_MAX_CONCURRENT` | `4` | Maximum simultaneous local requests |
| `DOUBAO_API_KEY` | Required for speech | Server-only key from the Doubao speech console; enable TTS 2.0 for read aloud and streaming ASR 2.0 for dictation |
| `BAIDU_MAP_API_KEY` | Required for maps | Server-type Baidu Maps AK with MCP service access; loaded by `baidumap` locally |
| `DOUBAO_SPEAKER` | `zh_female_vv_uranus_bigtts` | Doubao TTS 2.0 Speaker ID; defaults to Vivi 2.0 |
| `SPEECH_TIMEOUT_MS` | `120000` | Synthesis request deadline; playback may finish later |
| `SPEECH_MAX_CONCURRENT` | `2` | Maximum simultaneous speech requests, separate from chat |
| `ASR_TIMEOUT_MS` | `140000` | Overall recognition deadline, including connection and final results |
| `ASR_MAX_CONCURRENT` | `2` | Maximum simultaneous recognition sessions |
| `PORT` | `8787` | Server port; Vite proxy follows this value |

## Validate

```sh
npm run typecheck
npm test
npm run build
# With the app running:
npm run test:ui
npm run test:markdown:ui
npm run test:avatar:ui
```

Unit tests exercise the actual Harness loop using an explicitly injected test adapter, plus image validation and HTTP/SSE failure and cancellation behavior. Speech tests cover the Doubao binary protocols against local WebSocket servers, streamed audio/transcripts, final-packet handling and request cancellation, PCM decoding/resampling, and playback completion. UI tests use mocked provider responses and consume no provider credits. Image tests exercise browser decoding, upload history and preview controls; speech tests cover read aloud, cancellation and replay. `scripts/test-dictation-ui.mjs` drives an actual browser microphone/AudioWorklet pipeline using a generated test audio device and checks draft updates, finishing, cancellation, permission handling and localized errors. They use installed Google Chrome on macOS or Playwright Chromium (`npx playwright install chromium`) elsewhere. Real Poe and Doubao calls require valid provider credentials and are separate from these deterministic tests.

The strict application type check uses vendor declarations generated under the original Cordis compiler options. Runtime imports and the server bundle resolve directly to the retained source through `tsconfig.runtime.json`.

Map tests cover actual Harness tool dispatch and result replay with injected providers, MCP data normalization and real fetch cancellation, transaction isolation, expiration, invented POI rejection, route/time budgets, infeasible plans, safe navigation links, and streamed artifact parsing. Real Baidu and Poe calls are verified separately from deterministic tests. Map data can consume provider quotas; the application caps tool and route calls per turn and uses per-call deadlines.

## Repository

```text
Nihao-Agent/
├── apps/nihao/
│   ├── server/       # HTTP, Harness, Poe, Doubao and Baidu Maps
│   ├── shared/       # Validated conversation and travel types
│   └── web/          # React UI and browser-ready public assets
├── assets/           # Original brand and avatar artwork
├── docs/             # Architecture, design and source-task references
├── knowledge/        # Independent Python ingestion, retrieval and RAG project
├── packages/         # Retained Harness runtime source
├── vendor/           # Retained Cordis and schema libraries
├── scripts/          # Build, launch and browser-test commands
├── package.json
└── .env.example      # Variable names and defaults; no credentials
```

See [project layout and migration notes](docs/project-structure.md), [architecture](docs/architecture.md), [retained dependencies](docs/retained-packages.json), [fork notes](docs/fork-notes.md), [artwork](assets/README.md), and the [knowledge project](knowledge/README.md).

Dependencies, build output, Python environments, downloaded knowledge data and generated reports are local and ignored by Git. `.local/` preserves original archives and official speech examples on the existing machine. The ignored `deepseek-harness-master/nihao-knowledge` symlink preserves old local knowledge paths during migration; new work uses `knowledge/` directly. A fresh clone does not need that compatibility directory.

## Credits

Based on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), under its MIT license. Original notices are preserved in `LICENSE` and `THIRD_PARTY_NOTICES.md`. Markdown renderer dependency licenses are included in [markdown-notices.txt](apps/nihao/web/public/markdown-notices.txt). The interface follows the user's DeepSeek screenshot with Nihao branding and travel copy. Design review used [unslop](https://github.com/heydamir/unslop), by Damir Sokolovsky, under CC BY 4.0. Poe integration follows the [official compatible API documentation](https://creator.poe.com/docs/external-applications/openai-compatible-api). Read aloud follows the [Doubao bidirectional streaming TTS API](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-text-to-speech-websocket?lang=zh) and the protocol helpers supplied by the user; the runtime implements the protocol in TypeScript and does not require Python.

Dictation follows the [Doubao real-time recognition API](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh) and the user-supplied `sauc_python` wire protocol. Only protocol framing is implemented in the app; the demo's disk logging and file conversion helpers are not used.

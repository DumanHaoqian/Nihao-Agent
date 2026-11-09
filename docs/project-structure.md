# Project structure

`Nihao-Agent/` is the Git repository root and the Node application's working directory. Run `npm` commands here, not in the former `deepseek-harness-master/` directory.

| Directory | Responsibility |
| --- | --- |
| `apps/nihao/server/` | API server, Harness composition, model and speech adapters, map tools |
| `apps/nihao/shared/` | Shared conversation and travel contracts |
| `apps/nihao/web/` | React interface, streaming client, browser assets |
| `packages/`, `vendor/` | Retained upstream runtime dependencies and their licenses |
| `scripts/` | Build, development, local environment loading and UI checks |
| `knowledge/` | Independent Python ingestion, retrieval and RAG service |
| `assets/brand/`, `assets/avatar/` | Original editable artwork and avatar source package |
| `docs/` | Architecture, design decisions, attribution and original task references |

Browser assets remain in `apps/nihao/web/public/brand/`. These are deployable copies of the original artwork, so the app does not depend on files outside its build output. The Python project has its own dependencies and commands; the chat application does not require its virtual environment or local corpus.

## Existing-machine migration

The migration moved files without deleting original materials:

| Previous location | Current location |
| --- | --- |
| `deepseek-harness-master/` application files | Repository root |
| `deepseek-harness-master/nihao-knowledge/` | `knowledge/` |
| `image.png` | `assets/brand/logo-source.png` |
| `2D-Animation/chat-head.png` | `assets/avatar/chat-head.png` |
| `2D-Animation/nihao-avatar-pack-v1/` | `assets/avatar/nihao-avatar-pack-v1/` |
| `2D-Animation/AVATAR-INTEGRATION-PLAN.md` | `docs/avatar-integration-plan.md` |
| Original knowledge task and source seed | `docs/knowledge/` |
| Original source and avatar archives | `.local/archives/` |
| Official Doubao TTS and ASR examples | `.local/reference/doubao/tts/` and `asr/` |
| Historical migration manifests | `.local/reference/migration/` |

The active knowledge configuration remains `knowledge/config/sources.yaml`. `docs/knowledge/source-seed.yaml` is a historical source reference, not its replacement.

Existing local knowledge manifests, indices and virtual-environment scripts contain absolute paths. The ignored compatibility symlink `deepseek-harness-master/nihao-knowledge -> ../knowledge` keeps those paths working without rewriting historical records. Do not remove it while those local artifacts depend on it. New clones install their own environment in `knowledge/.venv/` and use `knowledge/` directly.

## Local files excluded from Git

- Credentials and personal environment files; only `.env.example` is tracked.
- `node_modules/`, `dist/`, caches, logs and UI test output.
- `knowledge/.venv/`, `knowledge/data/`, `knowledge/reports/` and Python build output.
- `.local/` archives and reference examples, plus the legacy compatibility directory.

Source code, tests and fixtures, active configuration, evaluation questions, original artwork, documentation and license notices are versioned. Reinstall dependencies and rebuild after cloning. Downloaded corpora and machine-local services are not transferred by a Git push.

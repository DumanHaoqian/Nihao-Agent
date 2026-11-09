# Nihao MVP fork

The source was provided as a downloaded DeepSeek Harness `0.2.2-rc.1` tree, without Git history. This fork keeps 43 source packages selected from production, peer and source-type dependencies. `retained-packages.json` records each path and why it is needed.

Removed areas include the upstream CLI, Electron desktop and developer Web applications; Python SDK; native add-ons; terminal, shell and computer-use implementations; unrelated tool/plugin packages; benchmarks, recorded upstream sessions, documentation website and upstream release/CI scripts. The original full source archive is preserved at `.local/archives/deepseek-harness-upstream-backup.tar.gz`, relative to the `Nihao-Agent/` project root, for recovery. No checksum validation was performed or added.

The application now lives directly in `Nihao-Agent/`, alongside `knowledge/` and the original brand material in `assets/`. The old `deepseek-harness-master/` wrapper contains only the `nihao-knowledge` compatibility symlink to `knowledge/`; it is ignored and is not an application source root. The supplied official Doubao TTS and ASR examples are retained as local reference material under `.local/reference/doubao/tts/` and `.local/reference/doubao/asr/`. The application implements their protocols directly and does not run these examples.

The fork uses app-owned npm scripts rather than the upstream `dsh` profiles and monorepo build. Original retained package manifests and READMEs describe the upstream packages; the root manifest owns installation here. Some upstream package documentation links refer to the full repository. Core runtime source is preserved, and the new server composes it through existing plugin interfaces.

To run the Nihao fork, use the root README. Upstream profile configuration, developer UI data and Python SDK entry points are not supported by this MVP. No existing user sessions or credentials are migrated, changed or deleted.

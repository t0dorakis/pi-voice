# pi-voice — Agent Context

## Quick Reference

| What | Command |
|------|---------|
| Type check | `npm run typecheck` |
| Lint | `npm run lint` |
| Unit tests | `npm run test:unit` (fast, no model/hardware) |
| Event tests | `npm run test:events` (mocked pi, plays real audio) |
| Server tests | `npm test` (unit + integration, ~60s, real kokoro-js q4) |
| E2E tests | `npm run test:e2e` (needs running server + pilotty) |
| Start server | `npm run server` |
| Verify before commit | `npm run typecheck && npm run lint` |

## Constraints

- **No build step** — pi loads `.ts` via jiti
- **2-space indent** — enforced by biome
- **Single model in memory** — every model-swap path calls `unloadModel()` first, which disposes ONNX sessions
- **Model ops are serialized** — load/download/delete chain through `withModelLock()`; never call the `*Impl` variants outside the lock
- **Peer deps use `*` range** — pi packages list `@earendil-works/pi-*` and `typebox` as `peerDependencies: "*"`

## Project Layout

```
extensions/
  index.ts             # Extension: /voice command, tts tool, auto-TTS events
  text.ts              # Pure text helpers (extraction, voice hints, markdown cleanup)
  config.ts            # Config types + load/save (path-injectable)
  audio.ts             # Player detection, WAV playback, serial play queue
  server.ts            # HTTP server: Kokoro ONNX TTS model lifecycle + REST API
  server.test.ts       # Server integration tests (node:test)
  events.test.ts       # Mocked-pi event tests (plays real audio)
  text.test.ts         # Unit tests for text.ts
  config.test.ts       # Unit tests for config.ts
  audio.test.ts        # Unit tests for audio.ts
bin/
  pi-voice.mjs         # CLI launcher (createJiti -> src/cli.ts; works inside node_modules)
src/
  cli.ts               # CLI: pi-voice server/model management
  prepare.js           # npm prepare script (writes default config if missing)
tests/
  helpers.sh           # Shared pilotty test utilities
  run.sh               # E2E test runner (tui, toggle, queue)
  tui.sh               # /voice TUI interaction tests
  toggle.sh            # alt+v toggle tests
  queue.sh             # Playback queue overlap tests
.agents/skills/        # pi-test, pi-init, pi-package skills
```

---

## Architecture

### Server (`extensions/server.ts`)

HTTP server managing the Kokoro ONNX TTS model lifecycle. Binds to `127.0.0.1:8181` by default.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server status, active dtype, model loaded |
| GET | `/voices` | Available voice names (model must be loaded) |
| GET | `/models` | All dtypes with download status |
| POST | `/models/download` | Download + auto-activate a dtype |
| POST | `/models/delete` | Delete cached files (unloads if active) |
| POST | `/models/activate` | Load a downloaded model |
| POST | `/models/unload` | Unload model, free memory |
| POST | `/tts` | Synthesize text → WAV audio |
| POST | `/shutdown` | Graceful shutdown |

**Model lifecycle** — `loadModel()` → `unloadModel()` → `downloadModel()` all enforce the single-model invariant and are serialized via `withModelLock()`. Corrupt cached ONNX files self-heal (deleted → re-download). `/tts` strips markdown via `cleanTextForSpeech()` before synthesis. Config persisted at `~/.pi/voice/manifest.json`.

### Extension (`extensions/index.ts`)

- `/voice` command — custom TUI (↑↓ navigate, ←→ cycle values, Enter sample, s save, r reset, Esc close)
- `tts` tool — LLM-initiated speech synthesis
- Auto-TTS — configurable per-event (`prompt` = summarize via LLM side-session, `text` = speak directly)
- Settings: on/off toggle, voice selector, speed (0.5–3.0); alt+v global toggle
- Persistence: `~/.pi/voice/config.json` for saved defaults (s key), session overrides via `pi.appendEntry()`
- Pure logic lives in `text.ts` / `config.ts` / `audio.ts` (unit-tested); index.ts is pi-facing wiring only

---

## Testing

### Unit Tests

`extensions/{text,config,audio}.test.ts` — fast `node:test` suites for the pure modules. No model, server, or audio hardware required. Run via `npm run test:unit` (also part of `npm test`).

### Event Tests

`extensions/events.test.ts` — mocks the pi API and fetch, drives the extension factory directly, and asserts the `voice:*` event contracts. Plays real audio via the platform player (macOS afplay); run via `npm run test:events`.

### Server Integration Tests

`extensions/server.test.ts` uses `node:test` with the real kokoro-js q4 model. Spawns one server process for the entire suite.

```
Validation (11) → Download (3) → Voices (1) → TTS (7) → Queue (5) → Unload (2)
→ Activate (2) → Model lock (2) → Lifecycle (4) → Corrupt cache (1)
```

### E2E Tests (`tests/`)

Pilotty-based PTY automation testing the full extension stack. Requires a running server with a loaded model and a working pi installation.

```bash
npm run server                # start server in one terminal
npm run test:e2e              # run all E2E tests in another
npm run test:tui              # run individual suites (tui, toggle, queue)
```

---

## Git Conventions

- **Conventional commits** — `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `refactor:`
- **Rebase merges only** — `gh pr merge <number> --rebase`
- **Release flow** — push to main → release-please opens Release PR → merge → auto publish

---

## Common Pitfalls

- **Memory leaks** — Always `unloadModel()` (→ `tts.model.dispose()`) before loading a new model. Never null without disposing.
- **No build step** — pi loads `.ts` via jiti. Never add a compile step.
- **Runtime deps go in `dependencies`** — not `devDependencies`.
- **`kokoro-js` has no download-only mode** — `from_pretrained()` always loads into memory, so `downloadModel()` must unload first.
- **dtype → ONNX filename is not `model_<dtype>.onnx`** — fp32 is `model.onnx`, q8 is `model_quantized.onnx` (transformers.js `DEFAULT_DTYPE_SUFFIX_MAPPING`). Use `getOnnxPath()`.
- **Never run the CLI/server `.ts` via a bare `node` bin or `--import jiti`** — Node refuses native type stripping inside node_modules, and `--import jiti` doesn't register hooks. Use `bin/pi-voice.mjs` / the absolute `jiti-register.mjs` path.

---

## Pi Package Docs

When implementing extension features, read the official docs:
- Extensions: `~/.local/share/npm/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Skills: `…/docs/skills.md` · Themes: `…/docs/themes.md` · Packages: `…/docs/packages.md`

# Launcher 2.0 (Tauri) — checkpoints

Branch `launcher-tauri`; the companion Electron hand-over is on branch `launcher-handover`.
Nothing has been published. No server was changed, and no access key was handled: test keys exist
only in the local fake feed.

## (a) Prototype — reached 2026-10-21

The UI, feed check, installed vs available, and a pack install into a scratch folder all work
against a local fake feed served with Basic auth.

**Linux:**
- `cargo test -p slums-core` passes 85 tests.
- The CLI (`core/examples/cli.rs`) probed the fake feed built by the real `tools/publish.mjs`:
  - no key: all three channels answer 401;
  - player key: Live only;
  - dev key: all three, after the server accepted user `slumsdev`.
- The CLI installed 306 files in 1.7 s: 10 packs plus 3 single files, every file SHA-256-verified.

**Silvia (`cargo tauri build`):**

| | |
| --- | --- |
| exe size | 5,273,600 bytes |
| `--version` | `SlumsMS Launcher 1.5.0` |
| self-test, window ready | 344–363 ms |
| self-test, first install complete | ~0.5 s from launch |
| self-test, warm re-verify | ~370 ms from launch |

**Found and fixed along the way:**
- serde_json's default float parsing is not bit-exact, so `state.json` mtimes never matched.
  Every check re-hashed files. Fixed with `float_roundtrip`, and a test now asserts zero hashing
  after an install.
- WebView2 cannot create a window in the SSH session (session 0). The smoke test now runs the exe
  through a one-off scheduled task in the logged-in session. The self-test window stays hidden.
- The rustup proxy links cannot be executed over SSH on Silvia (os error 448). The build uses the
  toolchain binaries directly.

## (b) Feature parity — reached

Each Electron feature, where it lives in the Tauri port, and how it was verified:

| Electron feature | Tauri | Verified |
| --- | --- | --- |
| Schema 1/2 manifests, layers, path/URL rules, aliases, reserved dirs | `manifest.rs` | unit + HTTP tests |
| Layer manifest SHA-256 pin, layer cache, only changed layers fetched | `release.rs` | `only_layers_whose_version_changed_are_downloaded` |
| Fast verify (size+mtime), Repair (full hash), the documented limit | `install.rs` | `fast_verify_trusts…` |
| Electron `state.json`/`installed.json` read as-is | same formats, Node mtime formula, exact floats | unit + install tests |
| playerOwned `config.ini` never overwritten | `install.rs` | `player_owned_config…` |
| Packs: plan, whole/ranged, dedupe, empty files, Range resume at exact byte, stall resume, no-Range server, damaged/missing pack fallback, resumed first install, disk-space refusal, small update per-file, shadowed content | `install.rs`, `packs.rs` | 10 pack tests |
| Retries with backoff, 404 permanent, corrupt payload never replaces | `install.rs` | `per_file_downloads…`, `a_corrupt_payload…` |
| Basic auth bound to the feed origin; cross-origin redirect drops it (also on bounce-back); 401/403 never retried; no credentials in URLs | `http.rs` | access-key tests |
| Built-in key only for the built-in feed origin | `config.rs` | unit |
| Installed vs available (Unknown / Not installed / Couldn't check), 10-min re-check | `release.rs`, app | tests + smoke |
| Progress line ("Downloading 12 of 91 packs, 3.4 of 21.7 GB, 45 MB/s, about 6 min left"), never backwards, Continue install | `packs.rs`, `install.rs` | unit + resume test |
| Verify less (30-min reuse; install does no second pass) | `play.rs`, app | unit |
| Play gate: re-read the manifest, update first, "Couldn't check for updates" fallback, `installed.json` launch command | `play.rs`, app | unit + Silvia smoke (`play` step) |
| Launch via ShellExecute (UAC prompt honoured), game folder as working dir | `play::launch` (ShellExecuteExW) | Silvia smoke |
| Game options: same keys, rules, byte preservation, refuse while the game runs (pending until closed/Play) | `game_options.rs`, `game_config.rs` | 16 tests + Silvia smoke (`options`) |
| Settings: folder (change/open/default), key (save/clear), Repair, update server (save/reset) | app commands | UI shots + smoke |
| `launcher.config.json` beside the exe; bundled client detection; `%LOCALAPPDATA%\SlumsMS` default | `config.rs` | unit |
| Close during an operation: prompt, clean stop within 5 s | app | code review (needs the owner's click) |
| Single instance, log file without the key, `--feed-url=` / `--install-dir=` | app | smoke |
| Release news (plain text) | ui | UI shots |

## (c) Channels, migration, self-update, hand-over — reached

- **Channels:**
  - player key: Live only, no picker;
  - dev key (`slumsdev`): Live, Test and RC with a picker, and Test/RC each in their own folder
    on first switch;
  - a refused choice falls back to Live.
  - Verified: unit tests, CLI, and the Silvia smoke `dev` run (switch to Test, install 306 files
    into `install-live-test`, back to Live).
- **Migration:**
  - The Electron settings are read once and never written.
  - The feed maps to a channel, and the folder stays where it is.
  - When the folder does not look Live, the player is asked in a one-time dialog.
  - Verified: unit tests, plus the Silvia smoke `migrate-live` (folder kept as Live) and
    `migrate-ask` (RC feed with a Live install: asks "looks like a Live install (1.0.0), but the
    old launcher was set to the RC channel").
- **Self-update:**
  - Tauri updater plugin, minisign key, `requireSignedVersion`.
  - Per-channel `CHANNEL/tauri/launcher.json`, published with
    `tools/publish.mjs --tauri-launcher`.
  - The single-exe swap has a health check and rollback.
  - Verified:
    - `core/tests/selfupdate.rs` renames a running exe aside on real Windows (Silvia) and on
      Linux, starts the new one, keeps a healthy build, and rolls back one that exits or hangs;
    - the publisher test (`test/tauri-publish.test.mjs`) uses a throwaway key.
  - **Not verified end to end:** the plugin's own check and download against a real HTTPS
    channel. That needs a published test channel, and the plugin refuses plain HTTP in release
    builds.
- **Hand-over:** see `handover-plan.md`. Electron 1.5.0 is on `launcher-handover` (commit
  1cfb59c, 86 Node tests): it fetches, verifies, swaps and waits for health, and rolls back
  otherwise.

## Test counts

| Where | Suite | Result |
| --- | --- | --- |
| Linux (dev box) | `cargo test -p slums-core` | 57 unit + 26 feed/HTTP + 2 real-process swap = **85 pass** |
| Silvia (Windows 11, rustc 1.97) | `cargo test -p slums-core` | 53 unit (4 Unix-only shell-script swap tests excluded) + 26 + 2 = **81 pass** |
| Linux | `npm test` (Electron suite + Tauri publisher) | **82 pass** on `launcher-tauri`; **86 pass** on `launcher-handover` |
| Silvia | smoke (`tauri-smoke.ps1`) | `--version`, first/warm/dev/migrate-live/migrate-ask: all ok |

## Known gaps and risks

- The updater plugin's network path is unverified until a Test channel is published. See (c).
- WebView2 is required. It ships with Windows 11 and updated Windows 10. Without it, the player
  gets a dialog with Microsoft's download link, and an Electron hand-over rolls back on its own.
- SmartScreen: the exe is unsigned (no Authenticode). A new exe name/hash may show "Windows
  protected your PC" the first time someone downloads it directly. Self-updates and the
  hand-over are written by the launcher itself, so they carry no Mark-of-the-Web.
- Antivirus may dislike an exe renaming itself. The swap retries for ~10 s and rolls back on
  failure.
- Electron leftovers (`resources/`, DLLs) stay beside the Tauri exe after the hand-over; a later
  release can clean them up.
- `ui/` is a copy of `../src` UI files with small edits (`bridge.js`, the channel row, the folder
  question). Port UI changes to both until the Electron launcher is retired.

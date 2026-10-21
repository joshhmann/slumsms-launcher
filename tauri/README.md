# SlumsMS Launcher 2.0 (Tauri) — 1.5.0

This is the launcher as one small Windows exe, built on Tauri v2 and Rust with the system
WebView2. It replaces the Electron launcher in `../src`, which stays unchanged until the
hand-over. The page (`ui/`) is the Electron page. It now talks to Rust commands instead of the
Electron preload bridge.

| | Electron 1.3.x/1.4.x | Tauri 1.5.0 |
| --- | --- | --- |
| What players get | 154 MB ZIP, 387 MB in 72 files unpacked (1.3.3 build) | one exe, **5.28 MB** (5,275,136 bytes) |
| Window ready (Silvia, self-test) | not measured | **~0.35 s** (first check done by ~0.37-0.5 s) |
| Runtime | bundled Chromium + Node | WebView2 (in Windows 10/11) |

## Layout

```text
tauri/
  Cargo.toml              workspace (release profile: size-optimised, LTO, stripped)
  launcher.config.json    built-in defaults (feed URL, client exe, concurrency); no access key
  core/                   slums-core: everything testable without a window
    src/manifest.rs         manifest/layer/path/URL validation (port of updater.mjs)
    src/http.rs             HTTPS-only transport, manual redirects, origin-bound Basic auth
    src/release.rs          load release + layer cache, availability check, state.json, installed.json
    src/install.rs          fast/full verify, per-file + pack downloads, Range resume, retries, stall, disk space
    src/packs.rs            pack index validation, planner, speed/ETA, progress line
    src/game_options.rs     config.ini parse/edit, byte-for-byte (port of game-options.mjs)
    src/game_config.rs      config.ini file side + "is the game running" (Toolhelp32 on Windows)
    src/config.rs           launcher.config.json layering, feed URL / key rules, bundled/standalone folder
    src/play.rs             Play gate (playPlan / reuseVerified), ShellExecuteEx launch with UAC
    src/channels.rs         Live/Test/RC feeds, probing (server decides), per-channel folders
    src/settings.rs         settings v2 + one-time migration from the Electron launcher
    src/selfupdate.rs       single-exe swap: rename running exe aside, start new, health check, rollback
    examples/cli.rs         dev CLI: probe / status / install without a window
    tests/                  HTTP behaviour tests against a local fake feed; real-process swap tests
  app/                    the Tauri app (commands, events, window, updater plugin, WebView2 check)
  ui/                     index.html, style.css, renderer.mjs (+ bridge.js for Tauri)
  devtools/fake-feed.mjs  local Basic-auth feed built with the real publisher (dev only)
  docs/                   checkpoint notes, hand-over plan, nginx dev tier
```

## Build and test

```sh
# any OS: the core and its tests (Linux needs no WebKit for these)
cd tauri && cargo test -p slums-core

# Windows (Silvia): the exe
cargo install tauri-cli --version "^2" --locked     # once, into the user's cargo
cd tauri/app && cargo tauri build                   # -> tauri/target/release/SlumsMS Launcher.exe
```

On Silvia over SSH, the rustup proxy links in `.cargo\bin` can't be executed (os error 448).
The build script in `Z:\MSv83\SlumsMS-dev\scratch-skills\tauri-build.ps1` therefore puts the
toolchain's own `bin` first on `PATH`. It also runs a copy of `cargo-tauri.exe` from
`Z:\MSv83\SlumsMS-dev\launcher-tauri-tools\`.

`tauri.conf.json` has `bundle.active: false`. The product is the bare exe, with no installer.

### Self-test

```sh
"SlumsMS Launcher.exe" --version                       # prints "SlumsMS Launcher 1.5.0"
"SlumsMS Launcher.exe" --self-test=report.json --data-dir=SCRATCH --feed-url=http://127.0.0.1:8787/manifest.json \
    --install-dir=SCRATCH\game --self-test-steps=install,options,play,channel:test,install,channel:live
```

The self-test window stays hidden. The run writes start-up times, the first check, each step's
result and the settings to `report.json`, then exits. The report shows only whether a key is
saved, never the key. `--data-dir` keeps the self-test away from the real settings, and
`--legacy-dir=DIR` feeds it fake Electron settings.

WebView2 needs the interactive desktop. The SSH smoke test (`tauri-smoke.ps1`) therefore runs
the exe through a one-off scheduled task in the logged-in session. It deletes the task
afterwards.

### Local fake feed

```sh
node tauri/devtools/fake-feed.mjs build /tmp/feed --files 300 [--exe-from C:\Windows\System32\rundll32.exe]
node tauri/devtools/fake-feed.mjs serve /tmp/feed --port 8787
```

The fake feed has Live, Test and RC channels, built by `tools/publish.mjs` itself, so the Rust
code is checked against the real publisher. It accepts two keys that exist only on this dev
server: user `slums` with key `player-local` opens Live, and user `slumsdev` with key `dev-local`
opens all three.

## Behaviour (same as Electron unless noted)

Everything in `../README.md` still holds:
- the feed and manifest protocol (schema 1 and 2, layers, packs, Range resume, damaged-pack
  fallback);
- fast verify against `state.json` and full Repair;
- the `playerOwned` `config.ini`;
- the Play gate;
- Game options;
- the access-key rules;
- news, the progress line, and "Continue install".

The Rust port keeps every file format. A game folder installed by the Electron launcher keeps
its fast verify and its "Installed" version. An Electron install's `state.json` mtimes compare
bit-exactly: they use the same formula as Node, and serde_json is built with
`float_roundtrip`.

What is new:

- **Channels.**
  - Live is `manifest.json`, Test is `launcher-test/manifest.json` and RC is
    `launcher-rc/manifest.json`, all beside the Live feed.
  - The launcher probes all three with the saved key: a player key opens Live only, and the dev
    key opens all three. The server decides, via `slums` or `slumsdev` Basic auth (see
    `docs/nginx-dev-tier.md`).
  - The CHANNEL row in STATUS always shows the active channel. The picker appears only when the
    key opens more than one channel.
  - A refused channel falls back to Live, and the row says so.
- **Folders per channel.**
  - Live stays exactly where it is: the folder you chose, else the folder bundled beside the
    launcher, else `%LOCALAPPDATA%\SlumsMS`.
  - Test and RC get their own folder (`<Live folder>-test` / `-rc`) the first time you switch to
    them. That folder is saved, so later Live changes don't move it.
  - Two channels never share a folder.
- **Settings** live in `%APPDATA%\com.slumsms.launcher\settings.json`, written atomically. The
  log is `launcher.log` in the same folder, rotated at 1 MiB, and never contains the key.
- **Migration** happens once, on the first start without Tauri settings. See
  `docs/handover-plan.md`.
- **Self-update** is signed, through the Tauri updater plugin.
  - Each channel has a manifest at `CHANNEL/tauri/launcher.json`. That name matches the patch
    server's existing no-cache rule for `launcher.json`.
  - The plugin downloads the build and verifies its minisign signature against the public key in
    `tauri.conf.json`. With `requireSignedVersion`, the signed version must equal the announced
    one.
  - The build URL must be on the feed's own origin, which is the only place the key goes.
  - The running exe is renamed into `.slumsms-launcher-update/rollback/`, and the new exe takes
    its name and starts.
  - The old process waits, window hidden, for `healthy-VERSION`. If the new exe exits or stays
    silent, the old process kills it, moves its own exe back and carries on.
  - Debug builds, `--self-test`, `--no-self-update` and `SLUMSMS_NO_SELF_UPDATE=1` skip
    self-update.
- **WebView2 missing or broken:** a plain dialog explains it and offers Microsoft's download page.
  The window opens hidden and appears once it is set up, so it never flashes white.

## Signing and publishing a launcher build (owner)

- **Private key:** `/root/.config/slumsms-launcher/tauri-signing.key` on the dev box, chmod 600,
  no password, outside the repo. Its public half is in `app/tauri.conf.json`
  (`plugins.updater.pubkey`) and in the hand-over build. If the private key is lost, no
  installed launcher will accept another update, so back it up offline.
- **Sign** (where the key is):

  ```sh
  cargo tauri signer sign -f /root/.config/slumsms-launcher/tauri-signing.key -p "" --app-version 1.5.1 "SlumsMS Launcher.exe"
  ```

- **Publish:** test first, then RC, then live. Nothing has been published yet.

  ```sh
  node tools/publish.mjs --tauri-launcher "SlumsMS Launcher.exe" --signature "SlumsMS Launcher.exe.sig" \
    --version 1.5.1 --base-url https://slumspatch.asslorde.com/launcher-test/ --out /srv/slums-patch/launcher-test
  ```

## Files the launcher touches

| Where | What |
| --- | --- |
| `%APPDATA%\com.slumsms.launcher\` | `settings.json`, `launcher.log` |
| `%LOCALAPPDATA%\com.slumsms.launcher\EBWebView\` | WebView2 profile |
| `%APPDATA%\mapleroot-launcher\settings.json` | read once (migration), never written |
| game folder | managed files, `config.ini` (Game options only), `.slumsms-launcher/` (state, installed, layer cache), `.mapleroot-stage-*` while downloading |
| beside the exe | optional `launcher.config.json` (read), `.slumsms-launcher-update/` (self-update), `resources/app.asar` of an Electron install (read once for a built-in key) |

# AGENTS.md: SlumsMS launcher (Tauri 2.0 and the Electron hand-over)

Read the main handbook first: `AGENTS.md` in the server repo (joshhmann/SlumsMS, branch `test-1.5.0-rc6` or newer).
Its hard rules apply: Live is the owner's, secrets never pass through you, the owner's desktop is read-only except
`Z:\MSv83\SlumsMS-dev\`, and a refused action stays refused.

- **Branches:** `launcher-ui-compact` is Tauri 1.5.1 (the current Tauri line); `launcher-handover` is the Electron
  build that moves old launchers to Tauri and must contain `7f385b0` (pure-JS BLAKE2b; Electron's crypto has none).
- **Tests:** `npm test` at the repo root; `cargo test -p slums-core` in `tauri/`. The app crate builds on Windows only.
- **Build** the exe on Silvia in a new folder under `Z:\MSv83\SlumsMS-dev\`. **Sign** on the dev box only:
  `cargo tauri signer sign -f /root/.config/slumsms-launcher/tauri-signing.key -p "" --app-version <v> <exe>`. The key
  never leaves the dev box and is never printed.
- **Channels:** Live `/srv/slums-patch/` (player key), Test `/launcher-test/` and RC `/launcher-rc/` (dev key only).
  Publish to Test/RC with `/opt/slums-tools/launcher-tauri-publisher` (see `/root/work/launcher-tauri-release/RUNBOOK.md`
  on the dev box). Live: Tauri first, then the hand-over, with the owner's go. A Live hand-over build needs the friends
  key baked in, and only the owner runs that build.
- **Trials:** self-update and hand-over trials run from new folders with `--data-dir`, backing up the owner's settings
  first and restoring them after.

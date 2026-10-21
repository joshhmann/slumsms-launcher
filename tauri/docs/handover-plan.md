# Hand-over plan: Electron launcher to Tauri launcher (1.5.0)

**Goal:** every player's Electron launcher turns into the Tauri exe by itself:
- no new download link;
- no re-install of the game;
- no change to the game folder;
- the access key keeps working (a typed one or a friends-build one).

There are two pieces:

| Piece | Branch | What it is |
| --- | --- | --- |
| Tauri launcher 1.5.0 | `launcher-tauri` (`tauri/`) | the new exe |
| Electron 1.5.0 "hand-over build" | `launcher-handover` | the last Electron release; its only new job is to fetch, verify and start the Tauri exe |

Neither has been published.

## How it plays out on a player's PC

1. **Electron (1.3.x/1.4.x) self-updates to Electron 1.5.0**, as for any Electron release. Only
   `resources/app.asar` changes, through the existing `launcher.json` channel and swap helper.
2. **Electron 1.5.0 starts.** Its self-update check finds nothing newer, so it runs the hand-over
   (`src/handover.mjs`):
   1. It fetches `tauri/launcher.json` beside the feed's `manifest.json`. A 404 means nothing is
      published, so the player simply stays on Electron.
   2. The build URL must be HTTPS on the feed's own origin. The download uses the same key,
      origin and redirect rules as the game files. A stall of 60 s gives up.
   3. It verifies the minisign signature against the Tauri public key built into 1.5.0. It checks
      the global signature over the trusted comment, and that the comment's `version:` equals the
      announced version. It also checks for the `MZ` header.
   4. It stages the exe in `.slumsms-launcher-update/handover-1.5.0/`.
   5. It renames the running `SlumsMS Launcher.exe` to
      `.slumsms-launcher-update/electron-rollback/SlumsMS Launcher.exe`.
   6. It moves the Tauri exe in under the same name, so desktop and Start-menu shortcuts keep
      working.
   7. It starts the Tauri exe with `--handover-from=electron-1.5.0`, then waits up to 90 s for
      `.slumsms-launcher-update/healthy-1.5.0`.
   8. **Healthy:** Electron exits. **Not healthy** (missing WebView2, a crash, a hang): Electron
      kills the Tauri process and keeps its exe as `failed-handover-1.5.0-SlumsMS Launcher.exe`.
      It renames its own exe back and carries on as Electron. That is logged, and it is not
      retried that session.
3. **Tauri 1.5.0 starts for the first time.** It has no settings yet, so it migrates once:
   - It **reads**, never writes, `%APPDATA%\mapleroot-launcher\settings.json`
     (`{ feedUrl, installDir, accessKey, pendingGameOptions }`).
   - **Key:** the saved key carries over. If none was saved, the key built into the Electron
     friends build is read from `resources/app.asar` beside the exe. That key only carries over
     when the old feed is on the built-in key's origin, which is the same rule Electron used. The
     key is never shown or logged.
   - **Feed:** `feedUrl` maps to a channel. `/manifest.json` is Live, `/launcher-test/` is Test,
     `/launcher-rc/` is RC, and any other server stays a custom Live server.
   - **Folder:** the game folder stays exactly where it is.
     - No folder saved: Live uses the old default (`%LOCALAPPDATA%\SlumsMS`), or the bundled
       client beside the launcher. Same rules as Electron.
     - A saved folder holds the game and every signal says Live (its `installed.json` matches
       Live, or there is no record and the old feed was Live): it becomes the Live folder.
     - A saved folder holds the game but does **not** look like Live (its record matches
       Test/RC, its release name says rc/test, or the old feed was Test/RC): **the player is
       asked** in a one-time dialog ("Use it as Test / Use it as Live / Not now"). Nothing is
       moved, copied or downloaded.
     - A saved folder holds no game yet: it stays the folder of the old feed's channel.
   - **Game options:** `pendingGameOptions` for that folder carry over.
   - When it is done, Tauri writes the health marker, and Electron (step 2.8) exits.
4. **From then on, Tauri updates itself** from `CHANNEL/tauri/launcher.json` (signed).

**Left behind:**
- Electron's `resources/`, DLLs and `locales/`, plus `electron-rollback/`, stay beside the exe.
  They are harmless: the Tauri exe imports none of those DLLs.
- They are worth removing in a later Tauri release (1.5.x), once its health marker has been seen
  twice:
  - the known Electron files only: `resources\`, `locales\`, `*.pak`, the Electron DLLs,
    `LICENSES.chromium.html`, `snapshot_blob.bin`, `v8_context_snapshot.bin`;
  - only when `resources\app.asar` declares `"name": "mapleroot-launcher"`.

## Rollout order (owner)

Each step is a publish the owner approves.

1. **Server:** apply `docs/nginx-dev-tier.md` (the dev key for Test/RC).
2. **Test channel:**
   1. Publish Tauri 1.5.0 to `launcher-test/tauri/` with `--tauri-launcher`.
   2. Publish Electron 1.5.0 to `launcher-test/launcher.json` with `--launcher`, built from
      `launcher-handover` with the friends key baked in, as for 1.3.x.
   3. Start an Electron launcher that points at the Test feed (the owner's). Expect it to update
      to Electron 1.5.0, hand over, and show the Tauri window with the same folder and key.
3. **RC channel:** the same, if wanted.
4. **Live:**
   1. Publish Tauri 1.5.0 to `tauri/` first.
   2. Then publish Electron 1.5.0 to `launcher.json`.

   The order matters: an Electron 1.5.0 that finds no Tauri build just stays Electron (404 means
   nothing happens). Tauri first means players move in one go.
5. **New players** get the Tauri exe directly. The download link can point at
   `tauri/1.5.0/SlumsMS-Launcher.exe`. Save it as `SlumsMS Launcher.exe` anywhere and start it.

## Rolling back

- **Before Live:** don't publish. Electron users never notice.
- **A player's hand-over failed:** this is automatic (step 2.8), and that player stays on
  Electron 1.5.0.
- **Tauri is broken after the hand-over:** copy
  `.slumsms-launcher-update\electron-rollback\SlumsMS Launcher.exe` back over
  `SlumsMS Launcher.exe`. Electron's settings file was never changed.
- **A bad Tauri update (1.5.x):** this is automatic. A build that does not report healthy is
  replaced by the running one. By hand, use `.slumsms-launcher-update\rollback\`.

## Owner's own install

The owner's install is at `Z:\MSv83\testlauncherblehbleh`, and its old settings may point at RC or
Test feeds. The migration reads `installed.json` in that folder and compares it with what each
channel offers.
- If it is the Live build, the folder stays Live.
- If not, the dialog asks.

Either way the folder is not touched. Before going live, the owner can preview the result without
the hand-over:
- run the Tauri exe with `--data-dir=<scratch>`, which keeps its settings away from the real ones;
- leave out `--legacy-dir`, so it reads the real Electron settings (read-only);
- check the CHANNEL row and the folder in Settings.

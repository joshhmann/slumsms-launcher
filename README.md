# SlumsMS Launcher

Separate SlumsMS-branded launcher and static release publisher for the existing MapleRoot Windows client. This is a launcher-only rename: the server, game files, project directory, package identity and settings location remain unchanged. Existing BunsMS work is preserved. No game/server/DLL/Kaentake source or live services are changed by this project. Browser-game support is deferred.

## What works

- Select a writable game folder and a trusted HTTPS release manifest.
- Install an empty folder, verify installed files, and repair/download missing or changed files.
- Recursive loose IMG trees: no fixed WZ list and no asset-format conversion.
- Layered releases: a large, rarely changing `base` layer (game Data) and a small `client` layer (SlumsMS.exe, DLLs, Custom.wz, config.ini, overlays), each with its own version. Only layers whose version changed are fetched.
- Fast verify for Play (size + mtime against a per-install state file) and a full SHA-256 Repair.
- Streaming SHA-256 and size verification; configurable parallel downloads (default 12) with retry and backoff for transient failures; overall progress by bytes. Every download verifies in staging before it is moved into place.
- Player-owned files (by default `config.ini`) are installed once and never overwritten afterwards.
- Play fast-verifies the selected release, then starts its configured executable/arguments with the game folder as working directory. Windows uses Start-Process/ShellExecute so the client can request its own UAC elevation. The launcher does not rewrite client INIs.
- Settings live in Electron's per-user application-data directory, separate from the game installation.
- A dependency-free Node publisher makes immutable version folders and publishes manifest.json last.

The player UI is Electron with a sandboxed renderer, context isolation, a narrow preload bridge, local assets/CSP, and no Node access in the page. It has no account/password handling, dashboard requirement, fabricated server/news data, telemetry or launcher-self-update.

## Develop and package

Use Node22 or newer, then:

```sh
npm ci
npm start
npm test
npm run build:win
```

If your package manager blocks Electron's dependency install script, review it and run `node node_modules/electron/install.js` to fetch the desktop runtime. Windows build output is `dist/SlumsMS-Launcher-0.1.0-win-x64.zip`. Extract the entire ZIP and run `SlumsMS Launcher.exe`; keep the accompanying resources. The ZIP is unsigned: Windows/SmartScreen trust and actual Windows launch/UAC acceptance still need verification on the target PC. Do not tell players to disable antivirus protections.

This LXC used a checksum-verified isolated Node runtime under `/tmp/node-v24.22.0-linux-x64/`; Node was not installed globally. Prefix local development commands with `PATH=/tmp/node-v24.22.0-linux-x64/bin:$PATH` while that runtime exists, or install Node normally for a durable developer setup.

## Publishing releases (layers)

A release is a small top-level `manifest.json` that points at immutable **layer** versions. Layers apply in order; a later layer overrides an earlier one for the same path.

- `base`: the loose MapleStory v83 Data tree and other rarely changing files (~23.6 GB, ~86k files). Publish it **once**, and again only when the game data changes.
- `client`: SlumsMS.exe, MapleStory.exe if it changes, slums.dll and other DLLs, Custom.wz, config.ini and overlay files. Publish a new client version for each release.

The publisher copies every regular file from the source directory and does not guess what is approved. Keep private keys, credentials, logs, private settings and development-only files OUT of the staging trees.

```sh
# (a) base layer, from the Data staging directory (once)
node tools/publish.mjs --layer base --source /srv/stage/base --out /srv/release --version v83-2026.10.19

# (b) client layer, for each release
node tools/publish.mjs --layer client --source /srv/stage/client --out /srv/release --version 2026.10.19-1

# point players at it (writes manifest.json last; later --use overrides earlier)
node tools/publish.mjs --release 2026.10.19-1 --out /srv/release \
  --use base@v83-2026.10.19 --use client@2026.10.19-1 [--news news.json]
```

Paths inside a layer are relative to its source directory, so the base source should mirror the client root (e.g. `/srv/stage/base/Data/Mob/...`). `--release` defaults to `--exe SlumsMS.exe` with no arguments and `--player-owned config.ini`; repeat `--player-owned PATH` to choose other files, `--no-player-owned` for none, and `--arg VALUE` for launch arguments. It refuses layers that are not published, an executable missing from every layer, Windows path aliases between layers, and re-using the version already in `manifest.json`.

Server layout:

```text
release-output/
  manifest.json                         <- small, mutable, written last; serve no-cache
  layers/
    base/v83-2026.10.19/
      manifest.json                     <- layer manifest (its SHA-256 is pinned in the top manifest)
      files/Data/Mob/0100100.img ...
    client/2026.10.19-1/
      manifest.json
      files/SlumsMS.exe, slums.dll, Data/Custom.wz, config.ini ...
```

Upload new layer version folders completely, then upload/replace `manifest.json` last. Layer version folders are immutable: never edit one in place, publish a new version instead. Serve `manifest.json` with revalidation/no-cache and `layers/` with long-lived caching. Any static HTTPS host/CDN/object store works; the launcher resolves layer manifests relative to the final (post-redirect) top manifest URL, and layer files relative to their layer manifest.

### Legacy single-folder releases

`node tools/publish.mjs --source DIR --out DIR --version VERSION [--exe SlumsMS.exe] [--arg VALUE ...] [--news FILE.json]` still writes a schemaVersion 1 release (`OUT/VERSION/...` plus `OUT/manifest.json`), and the launcher still reads schemaVersion 1 manifests.

## Launcher defaults and bundling

`src/launcher.config.json` ships inside the app and sets the defaults:

```json
{ "feedUrl": "https://slumspatch.asslorde.com/manifest.json", "clientExecutable": "SlumsMS.exe", "downloadConcurrency": 12 }
```

`feedUrl` must be HTTPS (HTTP only on localhost for development). `clientExecutable` is the file name used to detect a client shipped next to the launcher; what Play starts comes from the release manifest's `launch` (SlumsMS.exe, which starts MapleStory.exe with slums.dll). `downloadConcurrency` is 1-32. A packaged launcher also reads an optional `launcher.config.json` beside `SlumsMS Launcher.exe`, which overrides the built-in values without a rebuild. The player's own choices in Settings (stored in Electron's per-user `settings.json`) override both; "Reset to default" clears a custom update server.

The game folder is chosen in this order:

1. A folder the player picked in Settings.
2. Bundled: the folder containing the launcher, or its parent, when it contains `clientExecutable`. Ship the launcher in a `Launcher/` subfolder of the client so its runtime files stay out of the client root.
3. Standalone: `%LOCALAPPDATA%\SlumsMS`, which never needs elevation.

On start the launcher checks the release automatically (fast verify), then shows a single button: Install (no client yet), Update (files changed) or Play (verified). Repair, the game folder and the update server live behind the Settings (gear) button.

## Fast verify vs Repair

After every successful install, update or repair the launcher writes `.slumsms-launcher/state.json` inside the game folder: for each managed file its relative path, size, mtime and SHA-256.

- **Play / Check / Update (fast):** each file is `lstat`ed. A missing file or one whose size differs from the release is downloaded. A file whose size and mtime match the state, and whose recorded SHA-256 equals the release's, is trusted without being read. Anything else (changed mtime, no state entry) is hashed; if the hash matches, the new mtime is recorded so the next launch is fast again. An unchanged 86k-file install therefore costs only a stat pass instead of re-hashing 23.6 GB.
- **Repair (Settings > Verify and repair):** ignores the state and SHA-256 hashes every managed file, then downloads anything damaged.

Limit: an edit that keeps the same size **and** restores the same mtime is not seen by fast verify; only Repair catches it. Any ordinary tamper or corruption that changes size or mtime is caught on Play. The state file is a local cache, not a security boundary; deleting it just makes the next check hash everything.

Player-owned files (the release's `playerOwned` list; `config.ini` by default) are installed only when missing. An existing copy is never replaced, by Update or Repair, so a player's server address or settings survive releases. Delete it to get the release's default back.

## Downloads

Installs use per-file downloads (default 12 in parallel). Transient failures (network errors, short bodies, HTTP 408/425/429/5xx) are retried up to 4 times with exponential backoff and jitter; a 4xx or a full-size SHA-256 mismatch fails immediately. Progress is reported as overall bytes and file counts, throttled to about 10 updates a second; the file list itself never crosses into the page.

Each file is downloaded into `.mapleroot-stage-*`, size- and SHA-256-verified, then moved into place. Files that did not exist yet are moved in as soon as they verify and recorded in the state (checkpointed every 15 s and on failure), so an interrupted first install resumes where it left off without re-downloading or re-hashing finished files. Files that replace existing ones are moved in only after every download in that run has verified. An interrupted single file restarts from zero (no HTTP range resume).

Chunked archives were considered and not implemented: the Data .img files barely compress (~97% under xz), so archives would save little bandwidth while costing resumability, extra disk space and a second verification path. Per-file downloads are correct on their own.

## Release news

Add `--news FILE.json` when publishing to include release notes in `manifest.json`. The launcher shows them in a Latest updates panel after each check, as plain text only (no HTML or links):

```json
[
  { "title": "Henesys festival", "date": "2026-10-18", "body": "Double EXP all weekend.\nSee you there." },
  { "title": "Patch notes" }
]
```

At most 10 entries. `title` (up to 120 characters, one line) is required; `date` (`YYYY-MM-DD`) and `body` (up to 1000 characters, line breaks allowed) are optional. News is part of the top-level manifest, so changing it means writing a new release version (`--release`); layers do not need republishing.

## Manifest contract

The publisher generates these fields; do not hand-edit them.

- **schemaVersion 2 (top level):** `{ schemaVersion: 2, version, launch: { executable, args }, news?, playerOwned?: [path], layers: [{ name, version, manifestUrl, sha256 }] }`. `sha256` is the hash of the layer manifest's exact bytes; the launcher refuses a layer manifest that does not match. Layer names are letters/digits/`-`/`_`; versions are single safe path components.
- **Layer manifest:** `{ schemaVersion: 2, layer, version, files: [{ path, size, sha256, url }] }`, `layer`/`version` must match the reference. File URLs are relative to the layer manifest.
- **schemaVersion 1 (legacy):** `{ schemaVersion: 1, version, launch, files, news?, playerOwned? }` with file URLs relative to the manifest.

The launch executable must be a file of the merged release with identical spelling. Paths (files, launch, player-owned) reject traversal (`..`, absolute, drive or backslash paths), Windows device names, aliases/case collisions (also across layers), symlink destinations and the launcher's reserved `.slumsms-launcher/` and `.mapleroot-stage-*` directories. URLs must be relative, without schemes, fragments or protocol-relative hosts. Remote transport requires HTTPS; loopback HTTP is permitted only for local development, and HTTPS never redirects to HTTP.

The feed is trusted executable-distribution authority. SHA-256 verifies against the manifest; it does NOT independently authenticate a compromised manifest/host. TLS and release-host access controls are required. Do not add an untrusted release feed.

## Limits and recovery

- Unlisted local files are preserved, not deleted. This is not an obsolete-file removal system. Prefer a fresh dedicated folder for initial migration from another client.
- Updates transfer entire changed files, not binary deltas. Play uses fast verify; Repair hashes every managed file and takes time on a 23.6 GB install. Publishing is sequential (expect a long first base publish).
- Allow space for the changed files that replace existing ones in addition to the current installation (new files move into place as they verify). Downloads stage under `.mapleroot-stage-*` inside the installation.
- Unused layer files are not deleted when a layer version changes (unlisted files are preserved).
- Commit is atomic per file, NOT a whole-tree rollback transaction. A crash/disk error during replacement can leave a mixed tree; the next check blocks Play until repair. A bad download is rejected before replacement starts.
- Interrupted processes can leave staging directories, a reserved unpublished version directory or publisher `.mapleroot-publish.lock` directory. Ensure no process is using them before manual cleanup; use a new version rather than overwriting an already-published release.
- Close during an operation prompts before quitting. Native filesystem operations assume trusted local directories; portable Node does not eliminate hostile concurrent directory-swap races.
- Windows-specific UAC, native folder selection, antivirus and actual game startup require acceptance on the Windows PC. Linux helper-process proof is not game-client proof.

## Verification exercised

- Layered-release unit/HTTP tests (`test/layers.test.mjs`): publisher layer/top-level output and immutability; layer override order; only changed layers fetched (unchanged base layer manifest and files not requested); fast verify for unchanged, size change, mtime change, same-size tamper, missing, and the same-size-same-mtime limit caught only by Repair; player-owned config.ini; schemaVersion 1 compatibility; path traversal/reserved-path rejection in manifests, layer manifests and a hosted layer; retry/backoff, byte progress, permanent 404 and resumed install.
- Scale smoke (not in the suite): 30k-file layer on Linux, fast verify of an unchanged install ~1.2 s vs ~3.8 s full hash of tiny files; state file ~4 MB.
- Five passing real-HTTP regression scenarios: fresh nested install/unchanged scan/repair with player-file preservation; corrupt payload preventing partial replacement; immutable publication/symlinks/Windows path aliases; redirected feed resolution; optional release news round-trip and rejection. The redirect regression was observed failing before its fix and passing afterward.
- Launcher config unit tests: layered config files, feed URL rules, bundled-client detection beside or above the launcher, and the standalone default folder.
- Standalone real static publication, download, hash scan and single-file repair smoke.
- Actual Electron window via a virtual Linux display: Check → update-needed; Install → verified-ready; Play → real throwaway helper process with correct working directory and argument containing a space; invalid feed → displayed404 error → recovery after saving the correct feed.
- Windows ZIP packaging. This is not a claim that the game or Windows/UAC path was run here.

## Design references, not imported code

The old `/opt/buns-clean/launcher` established the existing Electron approach but couples to the Buns dashboard, flat manifests, INI rewriting and Kaentake assumptions. This project keeps those game-specific assumptions out.

The user also supplied [albinosin/Launcher_2016](https://github.com/albinosin/Launcher_2016), inspected at commit `92aec9cbf8b92a732727dd10bd79394048c08dbe`:

- [WPF project](https://github.com/albinosin/Launcher_2016/blob/92aec9cbf8b92a732727dd10bd79394048c08dbe/Launcher_2016/MapleCustom_Launcher.csproj) targets .NET Framework4 Client Profile.
- [MainWindow](https://github.com/albinosin/Launcher_2016/blob/92aec9cbf8b92a732727dd10bd79394048c08dbe/Launcher_2016/MainWindow.xaml.cs) checks a fixed WZ/DLL/EXE list with MD5, removes or backs up the old destination before downloading, and advances the completion queue without checking AsyncCompletedEventArgs.Error/Cancelled or hashing the completed download.
- [Hash publisher](https://github.com/albinosin/Launcher_2016/blob/92aec9cbf8b92a732727dd10bd79394048c08dbe/CalculateHash_Origins/Program.cs) uses nonrecursive Directory.GetFiles(updateFolder), so it does not generate a complete nested IMG manifest unchanged.
- GitHub reported no recognized license and the inspected root had no license file. No code/artwork was copied. It is a useful comparison, not the selected updater base.

## Desktop continuation

Clone this repository on Windows, install Node22 or newer, then run `npm ci` and `npm start`. Run `npm test` for the updater regressions and `npm run build:win` to package the launcher. The repository contains source/tools/tests, not client assets, install folders, private settings or built distributions.

Pending requested change, **not implemented yet**: game-server IP/port in the Settings panel.

Game-server address editing is not wired yet. A staged client outside this repository uses `config.ini` with `[config] host` and `port`; verify the actual desktop build's reader before implementing it. Ownership is now defined: `config.ini` is player-owned by default (installed once, never overwritten), so a saved address survives updates; the Settings editor itself still needs to preserve other INI fields. No production release feed or approved client package has been published.

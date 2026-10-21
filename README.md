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
- Play first re-reads the server's top-level manifest and compares it with the folder's `installed.json`: a newer (or republished) release is installed before the game starts (the button reads Update/Updating…). If the check fails (offline, 401/403, bad answer) Play starts the installed client anyway and says "Couldn't check for updates"; the game server's `MIN_CLIENT_BUILD` gate refuses a client that is really too old. Otherwise Play fast-verifies the selected release, then starts its configured executable/arguments with the game folder as working directory. Windows uses Start-Process/ShellExecute so the client can request its own UAC elevation. The launcher does not rewrite client INIs.
- Settings live in Electron's per-user application-data directory, separate from the game installation.
- A dependency-free Node publisher makes immutable version folders and publishes manifest.json last.
- Launcher self-update from its own channel (`launcher.json`) on the same patch server and access key: only changed files download, everything verifies before a swap, and a failed update rolls back.

The player UI is Electron with a sandboxed renderer, context isolation, a narrow preload bridge, local assets/CSP, and no Node access in the page. It has no account/password handling, dashboard requirement, fabricated server/news data or telemetry.

## Develop and package

Use Node22 or newer, then:

```sh
npm ci
npm start
npm test
npm run build:win
```

If your package manager blocks Electron's dependency install script, review it and run `node node_modules/electron/install.js` to fetch the desktop runtime. Windows build output is `dist/SlumsMS-Launcher-<version>-win-x64.zip` plus the unpacked `dist/win-unpacked/` (the folder the launcher channel publishes). Extract the entire ZIP and run `SlumsMS Launcher.exe`; keep the accompanying resources. The ZIP is unsigned: Windows/SmartScreen trust and actual Windows launch/UAC acceptance still need verification on the target PC. Do not tell players to disable antivirus protections.

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

# (c) optional, recommended for the base layer: first-install packs (see Packs below)
node tools/publish.mjs --packs base@v83-2026.10.19 --out /srv/release

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
      packs/0001.pack ... index.json    <- optional first-install packs (index SHA-256 pinned in the top manifest)
    client/2026.10.19-1/
      manifest.json
      files/SlumsMS.exe, slums.dll, Data/Custom.wz, config.ini ...
```

Upload new layer version folders completely, then upload/replace `manifest.json` last. Layer version folders are immutable: never edit one in place, publish a new version instead. Serve `manifest.json` with revalidation/no-cache and `layers/` with long-lived caching. Any static HTTPS host/CDN/object store works; the launcher resolves layer manifests relative to the final (post-redirect) top manifest URL, and layer files relative to their layer manifest.

### Packs (first install)

A first install of the base layer is ~86k files. `--packs NAME@VERSION` concatenates an already published layer version into ~256 MiB packs (`--pack-size MIB` to change), written to `layers/NAME/VERSION/packs/` beside `files/`:

- Packs are built from the published `files/`, re-hashing each against the layer manifest, so a damaged publish is caught. The layer's `files/` and `manifest.json` are not touched; old launchers keep using them.
- Deterministic: manifest order, each distinct content once (duplicates are copied on install), no headers, no compression (the Data IMGs compress only 2-5%). The same layer always gives the same bytes and the same index SHA-256.
- `packs/` is immutable (written to a temp folder and renamed in one step; a second `--packs` for the same version is refused). It is served with the same long-lived caching as `files/`.
- The next `--release` adds `packs: { url, sha256 }` to that layer's reference automatically (`--no-packs` leaves them out). Launchers before 1.3.3 ignore the field.
- Disk: packs roughly double that layer's footprint on the server (base: +23.3 GB).

`packs/index.json` is `{ schemaVersion: 1, layer, version, manifestSha256, packs: [{ url, size, sha256, files: [index into the layer manifest's files] }] }`; a pack is those files' bytes back to back, so each file's offset is the sum of the sizes before it.

### Legacy single-folder releases

`node tools/publish.mjs --source DIR --out DIR --version VERSION [--exe SlumsMS.exe] [--arg VALUE ...] [--news FILE.json]` still writes a schemaVersion 1 release (`OUT/VERSION/...` plus `OUT/manifest.json`), and the launcher still reads schemaVersion 1 manifests.

## Launcher defaults and bundling

`src/launcher.config.json` ships inside the app and sets the defaults:

```json
{ "feedUrl": "https://slumspatch.asslorde.com/manifest.json", "clientExecutable": "SlumsMS.exe", "downloadConcurrency": 12, "accessKey": "" }
```

`feedUrl` must be HTTPS (HTTP only on localhost for development). `clientExecutable` is the file name used to detect a client shipped next to the launcher; what Play starts comes from the release manifest's `launch` (SlumsMS.exe, which starts MapleStory.exe with slums.dll). `downloadConcurrency` is 1-32. A packaged launcher also reads an optional `launcher.config.json` beside `SlumsMS Launcher.exe`, which overrides the built-in values without a rebuild. The player's own choices in Settings (stored in Electron's per-user `settings.json`) override both; "Reset to default" clears a custom update server.

The game folder is chosen in this order:

1. A folder the player picked in Settings.
2. Bundled: the folder containing the launcher, or its parent, when it contains `clientExecutable`. Ship the launcher in a `Launcher/` subfolder of the client so its runtime files stay out of the client root.
3. Standalone: `%LOCALAPPDATA%\SlumsMS`, which never needs elevation.

## Access key (friends-only patch server)

The patch server can sit behind HTTP Basic auth (nginx `auth_basic`). The username is always `slums`; the access key is the password. The launcher sends `Authorization: Basic base64("slums:" + key)` on every request to the feed's origin (top-level manifest, layer manifests and files) and nothing else:

- **Origin-bound.** The header is attached only when a request's scheme, host and port equal those of the feed URL. Requests to any other origin never carry it.
- **Redirects.** Cross-origin redirects are followed but the header is dropped (and stays dropped for the rest of that redirect chain, even if a later hop points back at the feed), so a CDN or any other host never sees the key. HTTPS-only validation is unchanged: HTTPS releases cannot redirect to HTTP.
- **401/403** from the feed stops the operation immediately (no retries) and shows "This server needs an access key - enter it in Settings"; the main button becomes "Open settings".
- **Where the key comes from**, highest priority first: (1) the key the player saved in Settings > Access key, stored in Electron's per-user `settings.json` (never in the game folder; written with owner-only permissions where the OS supports it); (2) `accessKey` in `launcher.config.json` (the built-in one, or one beside the exe). The built-in key is used only while the update server is the built-in one, so a custom server never receives it. An empty key sends no header.
- The key is never logged, never shown, and never sent to the page: the renderer only learns whether a key is saved, built in or absent. "Clear saved key" removes the player's key and falls back to the built-in one, if any.

**How a friend enters the key:** open Settings (gear), type the key under Access key, press Save. The launcher re-checks immediately.

**Building a friends build with the key baked in:** set `"accessKey": "<the key>"` in `src/launcher.config.json`, then run `npm run build:win`. The key is then inside the ZIP (readable by anyone who has it), so share that ZIP only with friends, and do not commit the key: revert `accessKey` to `""` after building. To rotate, change the nginx password, rebuild, and tell friends to update or enter the new key in Settings.

On start the launcher checks the release automatically (fast verify), then shows a single button: Install (no client yet), Update (files changed) or Play (verified). Repair, the game folder and the update server live behind the Settings (gear) button.

## Installed vs available version

The STATUS panel shows two versions; the Settings footer reads "Launcher X · Game installed Y / available Z".

- **Installed** comes from `.slumsms-launcher/installed.json` in the game folder: `{ recordVersion: 1, release, manifestSha256, layers: [{ name, version, sha256 }], verifiedAt }`. The updater writes it only after an install, update, repair or verify that left nothing pending (unlike `state.json`, which is a hash cache checkpointed mid-install). It is read at startup, so it shows before any check. With no record it shows "Unknown" (a client executable is present) or "Not installed"; nothing is hashed for it. The automatic fast verify on start writes the record for an existing, intact install, so "Unknown" lasts only until that check passes.
- **Available** is the version in the server's top-level `manifest.json`, fetched (with the access key, same origin/redirect rules) when the window opens, every 10 minutes while the launcher is idle, and after a server or key change. It never fetches layer manifests or files. Offline, timeouts, 401/403 and bad answers show "Couldn't check" (hover for the reason) and are logged.
- States: equal versions show "Up to date"; a different available version highlights the panel and the main button reads Update (even after the launcher sat on Play while a release went out); no client shows "Not installed" with Install; same version with damaged files shows "Files need repair".

## Launcher self-update

Server, client and launcher share one version from 1.3.0 on; the launcher's version is `package.json` `version`. The 1.3.0 ZIP is the last one anyone installs by hand: later builds arrive through the launcher channel.

**Channel.** The launcher has its own channel beside the game manifest, never a game layer, so a game Repair or verify never touches launcher files and a launcher update cannot change the game install:

```text
release-output/
  manifest.json                         <- game release (unchanged)
  launcher.json                         <- launcher channel, written last; serve no-cache
  launcher/win32-x64/1.3.1/
    manifest.json                       <- per-file manifest in the layer format (path, size, sha256, url)
    files/SlumsMS Launcher.exe, resources/app.asar, ...
```

`launcher.json` is `{ schemaVersion: 1, version, platform, executable, manifestUrl, sha256 }`; `sha256` pins the exact bytes of the per-file manifest, like a layer reference. It is fetched from the feed's origin with the same access key, redirect rules and HTTPS rules as the game manifest.

**On start** (packaged builds only), before the first game check:

1. Fetch `launcher.json` (15 s timeout). No file (404), another platform, the same or an older version: nothing happens. Launchers never downgrade.
2. Show "Updating launcher…" and stage the new build in `.slumsms-launcher-update/stage-VERSION/` next to the launcher exe. Files whose SHA-256 matches the running launcher are copied locally; only changed files download (with `disableAsarIntegrity` the exe is the stock Electron binary, so a normal release changes only `resources/app.asar`, about 0.7 MB). Downloads use the game installer's code: size and SHA-256 verified, retried, resumable across restarts. No progress for 60 s aborts.
3. Start a swap helper (the staged launcher's own runtime with `ELECTRON_RUN_AS_NODE`, running `swap-helper.mjs`) and exit only after it confirms it is running.
4. The helper waits for the old launcher's process to exit (a running Windows exe cannot be overwritten), moves each replaced file into `.slumsms-launcher-update/rollback/`, copies the staged file in (executable last; sharing violations from antivirus or exiting child processes are retried for ~10 s), then starts the new launcher with `--self-updated=VERSION`.
5. The new launcher writes a health marker once its window has loaded. If it exits before that, or any swap step fails, the helper restores `rollback/` and restarts the old launcher with `--self-update-failed=VERSION`, which skips that version for one session.

Any failure (network, 401, hash mismatch, short download, unwritable folder such as Program Files, helper not starting) is logged and the current launcher carries on to the game check. `rollback/` keeps the previous launcher's replaced files (with `rollback.json`) until the next update; copying them back over the launcher folder undoes an update by hand. A build that reports a different version than the one it was installed as does not update again that session, so a mislabelled build cannot loop. `launcher.config.json` beside the exe is never part of the channel (the publisher refuses a build folder containing one). `--no-self-update` or `SLUMSMS_NO_SELF_UPDATE=1` turns self-update off.

**Log:** `launcher.log` in the per-user app data folder (`%APPDATA%\mapleroot-launcher\launcher.log` on Windows), rotated at 1 MiB; the swap helper writes to the same file. It never contains the access key.

**Publishing a launcher build** (after bumping `version` in `package.json` and building with the friends' access key baked in):

```sh
npm run build:win                                   # on the build PC; produces dist/win-unpacked/
# copy dist/win-unpacked/ to the publisher host, e.g. /srv/slums-staging/launcher-1.3.1/
node tools/publish.mjs --launcher /srv/slums-staging/launcher-1.3.1 --out /srv/release
```

The publisher reads the version from the build's own `resources/app.asar` (`--version X.Y.Z` is only a cross-check), copies and hashes every file into the immutable `launcher/win32-x64/VERSION/`, and writes `launcher.json` last. It refuses a version that is not newer than the published one, a build without a built-in access key (friends would lose access to every later update; `--allow-no-access-key` for an open server), a missing `SlumsMS Launcher.exe` and a `launcher.config.json` in the build folder. `--platform` (default `win32-x64`) and `--exe` select other targets. Uploading follows the game rule: version folder first, `launcher.json` last. Publishing the launcher never changes `manifest.json`, and publishing a game release never changes `launcher.json`.

## Fast verify vs Repair

After every successful install, update or repair the launcher writes `.slumsms-launcher/state.json` inside the game folder: for each managed file its relative path, size, mtime and SHA-256.

- **Play / Check / Update (fast):** each file is `lstat`ed. A missing file or one whose size differs from the release is downloaded. A file whose size and mtime match the state, and whose recorded SHA-256 equals the release's, is trusted without being read. Anything else (changed mtime, no state entry) is hashed; if the hash matches, the new mtime is recorded so the next launch is fast again. An unchanged 86k-file install therefore costs only a stat pass instead of re-hashing 23.6 GB.
- **Repair (Settings > Verify and repair):** ignores the state and SHA-256 hashes every managed file, then downloads anything damaged.

Limit: an edit that keeps the same size **and** restores the same mtime is not seen by fast verify; only Repair catches it. Any ordinary tamper or corruption that changes size or mtime is caught on Play. The state file is a local cache, not a security boundary; deleting it just makes the next check hash everything.

Verify less: after an install, update or check that left nothing pending, Play within 30 minutes skips the folder pass when the server still offers the same manifest (one small request); the first Play after the game has started does the fast stat pass again. Install no longer runs a second check after it finishes; it already verified every file it kept or wrote.

Player-owned files (the release's `playerOwned` list; `config.ini` by default) are installed only when missing. An existing copy is never replaced, by Update or Repair, so a player's server address or settings survive releases. Delete it to get the release's default back.

## Downloads

Before downloading anything the launcher checks free disk space (the pending bytes plus a margin of up to 512 MB) and stops with "Not enough disk space ..." instead of failing hours in.

**Packs (first install and other big downloads).** When the release publishes packs and at least 32 files are pending, the launcher fetches the layers' pack indexes (pinned by SHA-256 in the top manifest) and plans the download: a pack, or byte ranges of it, is used only when it is cheaper than one request per file (each request counts as 128 KiB). A first install therefore takes whole packs; a small update or a repair of a few files stays per-file. Content is matched by SHA-256 and size, so a base file shadowed by an identical client file is taken once from whichever pack offers it. Up to 4 packs download in parallel. Each pack is streamed straight into the individual files, each file is SHA-256-verified against the layer manifest before it is moved into place, and the pack itself is never stored, so no extra disk space is needed.

- A dropped or stalled connection (no data for 60 s) resumes the pack **at the exact byte** with an HTTP `Range` request, continuing the partial file and its hash. The retry budget (8 attempts, backoff capped at 30 s) refills whenever an attempt made progress, so a flaky home connection keeps going.
- A pack that is missing, damaged (a file fails its SHA-256) or served with a wrong range is abandoned, and what it still owed is downloaded per file. A server without range support still works (it sends whole packs; skipped bytes are discarded).
- Closing the launcher keeps every file that finished; the next Install continues with what is left (a file that was half downloaded starts again). Quitting mid-install stops the download cleanly (up to 5 s) so the finished files are recorded. On the next start the status reads "Checked 8.2 GB already downloaded. ... left to download" and the button says **Continue install**; while it runs the line starts with "Checked 8.2 GB already downloaded, continuing." and the bar counts on from the kept bytes.
- Progress is one steady line built from aggregate counters, never from whichever parallel pack or file reported last: "Downloading 12 of 91 packs, 3.4 of 21.7 GB, 45 MB/s, about 6 min left" (per-file downloads say "files"; speed and time left are measured over the last 20 s).

**Per-file** downloads (default 12 in parallel) handle everything else. Transient failures (network errors, stalls, short bodies, HTTP 408/425/429/5xx) are retried up to 4 times with exponential backoff and jitter; a 4xx or a full-size SHA-256 mismatch fails immediately. Progress is throttled to about 10 updates a second; the file list itself never crosses into the page.

Each file is downloaded into `.mapleroot-stage-*`, size- and SHA-256-verified, then moved into place. Files that did not exist yet are moved in as soon as they verify and recorded in the state (checkpointed every 5 s and on failure), so an interrupted first install resumes where it left off without re-downloading or re-hashing finished files. Files that replace existing ones are moved in only after every download in that run has verified. An interrupted per-file download restarts that file from zero. Staging folders older than an hour (left by a launcher that was killed) are removed at the next install.

Packs are not compressed: the Data .img files barely compress (~97% under xz), so compression would cost CPU on both ends for ~3-5%.

## Game options

The masthead's **Game options** button edits the switches the client reads from `config.ini` at start-up (`src/game-options.mjs` parses and edits the text, `src/game-config.mjs` reads and writes the file). Options, with the client's value when a key is absent:

| Panel label | Key | Default |
| --- | --- | --- |
| Show your game on Discord | `[discord] enableactivitystatus` | on |
| Allow the Windows key | `[clienthax] enablewinkey` | on |
| Hide the quest lightbulb | `[clienthax] nobulb` | on |
| Orange name and skill text | `[clienthax] customcolor` | on |
| Keep walking while attacking | `[clienthax] attackwalk` | off |
| Jump while attacking | `[clienthax] attackjump` | on |
| Move while charging skills | `[clienthax] chargemove` | on |
| Double-tap jump to Flash Jump | `[clienthax] doubletapjump` | on |
| Shoot in mid-air | `[clienthax] jumpshoot` | on |
| Cast magic in mid-air | `[clienthax] jumpmagic` | on |

`moveattack` (MapleRoot's single switch) is read, never written or removed: without the new keys the panel shows what the client does with it (the slide stays off; jump and charge follow `moveattack`). Changing any of `attackwalk`/`attackjump`/`chargemove` writes all three. Not exposed: `[general] resolution` and `ChairOpacity`/`SkillOpacity` (the single-DLL client ignores them; resolution is chosen in-game in System Options), `[config]` host/port and `[debug]`.

File safety: reading follows the client's inih parser (case-insensitive names, `;`/`#` comments, inline ` ;` comments, a repeated key makes the value unreadable). Edits replace only the value of an owned key (keeping its spelling, spacing and inline comment), drop repeats of that key, add a missing key at the end of its section or a missing section at the end of the file; every other byte (comments, order, unknown keys, CRLF, BOM, non-UTF-8 bytes) is kept, since the file is handled as latin1. Writes go to a temporary file beside it and are renamed over it. A missing `config.ini` is never created (it carries the server address; the install provides it). While `SlumsMS.exe` or `MapleStory.exe` is running, changes are kept in the launcher's settings and written when the panel is opened after the game closed, or at the next Play. A line the client cannot parse (which makes it ignore every option) is reported in the panel.

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

- **schemaVersion 2 (top level):** `{ schemaVersion: 2, version, launch: { executable, args }, news?, playerOwned?: [path], layers: [{ name, version, manifestUrl, sha256, packs?: { url, sha256 } }] }`. `sha256` is the hash of the layer manifest's exact bytes; the launcher refuses a layer manifest that does not match. Layer names are letters/digits/`-`/`_`; versions are single safe path components.
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
- Pack tests (`test/packs.test.mjs`): deterministic, deduplicated, immutable pack publishing that re-verifies published files; `--release` references packs and `--no-packs` omits them; index validation (layer/manifest binding, sizes, repeated indexes, unsafe URLs); the planner (whole packs for a first install, per-file for a small update, ranges that skip big gaps, shadowed content fetched once); a first install from packs with duplicates and empty files; a connection cut mid-pack resuming at the exact byte; a stalled pack resumed after the stall timeout; a server without range support; a damaged and a missing pack falling back to per-file; an aborted first install resuming without re-downloading; the disk-space refusal; speed/ETA estimates.
- Scale smoke (not in the suite): 30k-file layer on Linux, fast verify of an unchanged install ~1.2 s vs ~3.8 s full hash of tiny files; state file ~4 MB.
- Five passing real-HTTP regression scenarios: fresh nested install/unchanged scan/repair with player-file preservation; corrupt payload preventing partial replacement; immutable publication/symlinks/Windows path aliases; redirected feed resolution; optional release news round-trip and rejection. The redirect regression was observed failing before its fix and passing afterward.
- Access key HTTP tests (`test/access-key.test.mjs`): Basic header on manifest, layer manifests and files; no header with an empty key; header dropped on a cross-origin redirect and not re-attached when the chain bounces back; 401 gives the access-key error with exactly one request (load and mid-install); saved key overrides the built-in one, built-in key only for the built-in feed; config validation.
- Self-update tests (`test/self-update.test.mjs`): version ordering and never-downgrade; channel validation; launcher publisher (version from the asar, no-key, no-downgrade and player-config refusals, game manifest untouched); channel fetch with Basic auth, 404 as no update, 401 and tampered manifest hash; staging downloads only changed files and resumes without downloads; corrupt, truncated and 503 downloads leave the launcher unchanged; unwritable folder; helper swap with rollback copy and relaunch; rollback when the new build exits before its first window; rollback when a copy fails mid-swap; helper that cannot start; old launcher that never exits; cleanup.
- Self-update end to end with real Electron on Linux (Xvfb, linux-x64 builds 1.3.0 and 1.3.1, local Basic-auth server): 1.3.0 showed "Updating launcher", downloaded only `resources/app.asar`, the `ELECTRON_RUN_AS_NODE` helper swapped it and started 1.3.1, which reported healthy and went on to the game check; a corrupt download and a wrong key each left 1.3.0 running and logged. The Windows swap itself (exe/DLL locks, antivirus, SmartScreen) still needs a run on Windows.
- Version tests (`test/versions.test.mjs`): installed record round-trip, missing/corrupt record as unknown, written only by a clean install/verify (not by a verify with pending files), recovered for an unrecorded install by the next clean verify; availability check fetches only `manifest.json`, sends the key, maps 401, 404, unreadable manifest, refused connection and timeout without throwing; installed/available label and footer mapping.
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

Game-server address editing is not wired yet (the Game options panel deliberately leaves `[config]` alone). A staged client outside this repository uses `config.ini` with `[config] host` and `port`; verify the actual desktop build's reader before implementing it. Ownership is now defined: `config.ini` is player-owned by default (installed once, never overwritten), so a saved address survives updates; the Settings editor itself still needs to preserve other INI fields. No production release feed or approved client package has been published.

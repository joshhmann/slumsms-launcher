# SlumsMS Launcher

Separate SlumsMS-branded launcher and static release publisher for the existing MapleRoot Windows client. This is a launcher-only rename: the server, game files, project directory, package identity and settings location remain unchanged. Existing BunsMS work is preserved. No game/server/DLL/Kaentake source or live services are changed by this project. Browser-game support is deferred.

## What works

- Select a writable game folder and a trusted HTTPS release manifest.
- Install an empty folder, verify installed files, and repair/download missing or changed files.
- Recursive loose IMG trees: no fixed WZ list and no asset-format conversion.
- Streaming SHA-256 and size verification; six parallel downloads. Every changed payload verifies in staging before destination replacement begins.
- Play verifies the selected release, then starts its configured executable/arguments with the game folder as working directory. Windows uses Start-Process/ShellExecute so the client can request its own UAC elevation. The launcher does not rewrite client INIs.
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

## Publish only an approved Windows client build

The publisher copies every regular file from the source staging directory. It does not guess which configuration or build is current. Keep source private keys, credentials, logs, private settings and development-only files OUT of the approved staging tree. Client INIs are untouched only when they are unlisted; including one in the release makes it a managed file that may be replaced.

From this project in Windows PowerShell:

```powershell
$source = Read-Host 'Approved client staging directory'
$output = Read-Host 'Separate release output directory'
$version = Read-Host 'Unique release version'
$exe = Read-Host 'Client or bootstrap executable path relative to staging'
node tools/publish.mjs --source $source --out $output --version $version --exe $exe
```

Append repeated `--arg VALUE` pairs only when that executable requires arguments. The executable must be one of the published files. Paths inside the manifest use forward slashes. No executable name, server address, port or launch arguments are assumed for the Windows build currently in development.

Output:

```text
release-output/
  manifest.json
  VERSION/
    executable and complete approved client tree
```

Upload the entire new VERSION directory to static HTTPS hosting, then upload/replace manifest.json last. Keep the directory layout intact. Any ordinary HTTPS static host/CDN/object store can serve it; no running Node/dashboard API is required. Configure manifest.json for revalidation/no-cache and immutable version directories for long caching. The launcher supports redirected feed URLs and resolves payload paths against the final manifest location.

No public hostname, TLS deployment, live download service or official client release has been configured. The old control/repack files have NOT been published as the current client. Put the eventual HTTPS manifest URL in `src/launcher.config.json` (see below) so players never have to enter it.

## Launcher defaults and bundling

`src/launcher.config.json` ships inside the app and sets the defaults:

```json
{ "feedUrl": "https://example.com/manifest.json", "clientExecutable": "MapleStory.exe" }
```

Both values are placeholders: replace `feedUrl` with the real manifest URL and `clientExecutable` with the client's executable file name before building. A packaged launcher also reads an optional `launcher.config.json` beside `SlumsMS Launcher.exe`, which overrides the built-in values without a rebuild. The player's own choices in Settings (stored in Electron's per-user `settings.json`) override both; "Reset to default" clears a custom update server.

The game folder is chosen in this order:

1. A folder the player picked in Settings.
2. Bundled: the folder containing the launcher, or its parent, when it contains `clientExecutable`. Ship the launcher in a `Launcher/` subfolder of the client so its runtime files stay out of the client root.
3. Standalone: `%LOCALAPPDATA%\SlumsMS`, which never needs elevation.

On start the launcher checks the release automatically, then shows a single button: Install (no client yet), Update (files changed) or Play (verified). Repair, the game folder and the update server live behind the Settings (gear) button.

## Release news

Add `--news FILE.json` when publishing to include release notes in `manifest.json`. The launcher shows them in a Latest updates panel after each check, as plain text only (no HTML or links):

```json
[
  { "title": "Henesys festival", "date": "2026-10-18", "body": "Double EXP all weekend.\nSee you there." },
  { "title": "Patch notes" }
]
```

At most 10 entries. `title` (up to 120 characters, one line) is required; `date` (`YYYY-MM-DD`) and `body` (up to 1000 characters, line breaks allowed) are optional. News is part of the release, so changing it means publishing a new version.

## Manifest contract

`schemaVersion:1`, a nonempty `version`, `launch:{executable,args}`, `files:[{path,size,sha256,url}]`, and optional `news` (see above). The publisher generates these fields; callers should not hand-edit them. File URLs are encoded relative URLs. The launch executable is listed with identical spelling. Paths reject traversal, Windows device names, aliases/case collisions and symlink destinations. Remote transport requires HTTPS; loopback HTTP is permitted only for local development.

The feed is trusted executable-distribution authority. SHA-256 verifies against the manifest; it does NOT independently authenticate a compromised manifest/host. TLS and release-host access controls are required. Do not add an untrusted release feed.

## Limits and recovery

- Unlisted local files are preserved, not deleted. This is not an obsolete-file removal system. Prefer a fresh dedicated folder for initial migration from another client.
- Updates transfer entire changed files, not binary deltas. Checks/Play stream-hash every managed file; a large IMG installation takes time. Publishing/inspection are sequential; downloads use six workers.
- Allow space for the entire changed-file set in addition to the current installation. Downloads stage under `.mapleroot-stage-*` inside the installation.
- Commit is atomic per file, NOT a whole-tree rollback transaction. A crash/disk error during replacement can leave a mixed tree; the next check blocks Play until repair. A bad download is rejected before replacement starts.
- Interrupted processes can leave staging directories, a reserved unpublished version directory or publisher `.mapleroot-publish.lock` directory. Ensure no process is using them before manual cleanup; use a new version rather than overwriting an already-published release.
- Close during an operation prompts before quitting. Native filesystem operations assume trusted local directories; portable Node does not eliminate hostile concurrent directory-swap races.
- Windows-specific UAC, native folder selection, antivirus and actual game startup require acceptance on the Windows PC. Linux helper-process proof is not game-client proof.

## Verification exercised

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

Game-server address editing is not wired yet. A staged client outside this repository uses `config.ini` with `[config] host` and `port`; verify the actual desktop build's reader before implementing it. Preserve other INI fields and define ownership so updates do not overwrite a saved address or cause permanent checksum mismatches. No production release feed or approved client package has been published.

# Test channel trial: Tauri 1.5.0 → 1.5.1 self-update (prepared, NOT published)

Live stays untouched. Every command marked **[GO]** waits for the owner's dev key and the
coordinator's go.

## Staged inputs (dev box: `/root/work/launcher-tauri-release/`)

| File | SHA-256 |
| --- | --- |
| `1.5.0/SlumsMS Launcher.exe` (5,283,328 B) | `e190d701bf5265e5eae22cdf741e196490cf60496182bcef1ef1a0ebdefc99b2` |
| `1.5.1/SlumsMS Launcher.exe` (5,281,280 B) | `16edf4fdcf46df28d722e6f7e8cfb48d6d3632c0811d5c13d419b47b54ffd8d7` |
| `1.5.0/…exe.sig`, `1.5.1/…exe.sig` | minisign, `--app-version` bound; see `SHA256SUMS` |
| `publisher-launcher-tauri-cd17add.tar.gz` | `tools/` + `src/` + `package.json` with `--tauri-launcher` |

- Both exes were built on Silvia from `launcher-tauri` cd17add, in
  `Z:\MSv83\SlumsMS-dev\launcher-tauri-testchannel\`. The 1.5.1 build changes only the workspace
  version.
- They were signed on the dev box with `/root/.config/slumsms-launcher/tauri-signing.key`; the key
  never left it.
- Both signatures check out with the hand-over branch's independent verifier. Each is refused for
  the other's version.
- A rehearsal publish into a scratch copy produced `tauri/1.5.0/`, `tauri/1.5.1/` and
  `tauri/launcher.json`, and refused a downgrade.
- `publish.mjs` has no `--dry-run`. The dry run is step 2 below: publish into a throwaway copy on
  164.

## Publisher

- 164's copy (`/opt/slums-tools/launcher`) and `/root/work/launcher-publisher` are older and have
  **no** `--tauri-launcher`.
- Use the branch's publisher. Unpack it into a new folder beside the old one; the old folder is
  left as it is.

```sh
# from the dev box [GO]
scp /root/work/launcher-tauri-release/publisher-launcher-tauri-cd17add.tar.gz \
    "/root/work/launcher-tauri-release/1.5.0/SlumsMS Launcher.exe" "/root/work/launcher-tauri-release/1.5.0/SlumsMS Launcher.exe.sig" \
    root@192.168.0.164:/root/
ssh root@192.168.0.164 'mkdir -p /opt/slums-tools/launcher-tauri-publisher /srv/slums-staging/tauri-1.5.0 && \
  tar xzf /root/publisher-launcher-tauri-cd17add.tar.gz -C /opt/slums-tools/launcher-tauri-publisher && \
  mv "/root/SlumsMS Launcher.exe" "/root/SlumsMS Launcher.exe.sig" /srv/slums-staging/tauri-1.5.0/'
```

## Order on 164

```sh
N=/opt/slums-tools/node/bin/node
P=/opt/slums-tools/launcher-tauri-publisher/tools/publish.mjs

# 1. (prerequisite) the dev tier: docs/nginx-dev-tier.md steps 1-4 — owner creates the slumsdev key.  [GO]

# 2. dry run: publish into a throwaway copy, inspect, delete
rm -rf /tmp/tauri-dryrun && mkdir -p /tmp/tauri-dryrun/launcher-test
$N $P --tauri-launcher "/srv/slums-staging/tauri-1.5.0/SlumsMS Launcher.exe" --signature "/srv/slums-staging/tauri-1.5.0/SlumsMS Launcher.exe.sig" \
  --version 1.5.0 --base-url https://slumspatch.asslorde.com/launcher-test/ --out /tmp/tauri-dryrun/launcher-test --notes "Tauri launcher 1.5.0 (test channel)"
find /tmp/tauri-dryrun -type f && cat /tmp/tauri-dryrun/launcher-test/tauri/launcher.json && rm -rf /tmp/tauri-dryrun

# 3. Tauri 1.5.0 into the Test channel  [GO]
$N $P --tauri-launcher "/srv/slums-staging/tauri-1.5.0/SlumsMS Launcher.exe" --signature "/srv/slums-staging/tauri-1.5.0/SlumsMS Launcher.exe.sig" \
  --version 1.5.0 --base-url https://slumspatch.asslorde.com/launcher-test/ --out /srv/slums-patch/launcher-test --notes "Tauri launcher 1.5.0 (test channel)"
#    check: dev key 200, player key 401 (curl -u prompts for the key)
curl -s -o /dev/null -w '%{http_code}\n' -u slumsdev https://slumspatch.asslorde.com/launcher-test/tauri/launcher.json
curl -s -o /dev/null -w '%{http_code}\n' -u slumsdev https://slumspatch.asslorde.com/launcher-test/tauri/1.5.0/SlumsMS-Launcher.exe

# 4. later, once the owner runs 1.5.0 from the Test channel: publish 1.5.1 to trigger the self-update  [GO]
#    (scp the 1.5.1 exe + .sig to /srv/slums-staging/tauri-1.5.1/ first, as above)
$N $P --tauri-launcher "/srv/slums-staging/tauri-1.5.1/SlumsMS Launcher.exe" --signature "/srv/slums-staging/tauri-1.5.1/SlumsMS Launcher.exe.sig" \
  --version 1.5.1 --base-url https://slumspatch.asslorde.com/launcher-test/ --out /srv/slums-patch/launcher-test --notes "Self-update test build"
```

- Nothing touches `/srv/slums-patch/manifest.json`, `/srv/slums-patch/tauri/`,
  `launcher-test/manifest.json` or `launcher-test/launcher.json`. Electron 1.3.1 stays the test
  channel's Electron build.
- **Undo** (test channel only): `rm -rf /srv/slums-patch/launcher-test/tauri`. Launchers then find
  no update (404).

## Owner's test on Silvia (after step 3)

Use a NEW folder, e.g. `Z:\MSv83\SlumsMS-dev\launcher-tauri-testrun\`. **Don't** use
`Z:\MSv83\testlauncherblehbleh`.

1. **Get Tauri 1.5.0 from the Test channel.**
   - In a browser, open `https://slumspatch.asslorde.com/launcher-test/tauri/1.5.0/SlumsMS-Launcher.exe`.
     When it prompts, log in as user `slumsdev` with the dev key.
   - Save the file into the new folder as `SlumsMS Launcher.exe`.
   - Check its SHA-256: `Get-FileHash` should equal the 1.5.0 hash above.
2. **Start it with its own settings folder**, so your real settings never mix in:

   ```
   "SlumsMS Launcher.exe" --data-dir=Z:\MSv83\SlumsMS-dev\launcher-tauri-testrun\data
   ```

   It reads your Electron settings once, read-only. If the "YOUR GAME FOLDER" question comes up,
   answer **Not now**.
3. **Settings > Access key:** enter the **dev key** and save.
   - CHANNEL should show a picker with Live / Test / RC.
   - `data\launcher.log` says `user "slumsdev"`.
4. **Pick Test.**
   - The message names Test's own folder. Before installing you can change it in Settings > Change
     folder, e.g. `Z:\MSv83\SlumsMS-dev\launcher-tauri-testrun\game-test`.
   - Install. The Test feed offers game 1.4.1; this is a full first install from packs.
5. **Self-update 1.5.0 → 1.5.1** (after step 4 on 164).
   - Close the launcher and start it again with the same `--data-dir`. It is on Test now, so it
     reads `launcher-test/tauri/launcher.json`.
   - Expect "Updating launcher to 1.5.1…". The window disappears briefly and comes back as 1.5.1:
     Settings footer "Launcher 1.5.1".
   - In the launcher folder:
     - `.slumsms-launcher-update\rollback\SlumsMS Launcher.exe.1.5.0` exists;
     - `SlumsMS Launcher.exe` now hashes to the 1.5.1 value.
   - `data\launcher.log` shows "Self-update: downloading launcher 1.5.1", then "now running
     launcher 1.5.1".
   - Start it a second time while it is open: the existing window comes to the front. That checks
     single-instance after an update.
6. **Your Live install is untouched.** Before step 2 and after step 5, run in PowerShell:

   ```
   Get-ChildItem Z:\MSv83\testlauncherblehbleh -Recurse -File | Measure-Object Length -Sum
   Get-Item Z:\MSv83\testlauncherblehbleh\.slumsms-launcher\installed.json, Z:\MSv83\testlauncherblehbleh\.slumsms-launcher\state.json | Select Name, Length, LastWriteTime
   ```

   Count, size and the two timestamps must be the same.
   - `%APPDATA%\mapleroot-launcher\settings.json` must keep its LastWriteTime.
   - The test run's Live folder is `%LOCALAPPDATA%\SlumsMS` (its default), never
     `testlauncherblehbleh`, unless you choose it.

## Electron hand-over on the Test channel

1. **Key baked in:** yes for Live, optional for this trial.
   - For Live it is required: friends without a saved key rely on the key built into the Electron
     build, and the Tauri migration carries that built-in key over.
   - `publish.mjs --launcher` refuses a build without one unless `--allow-no-access-key` is given.
   - If the owner's own Electron launcher has the key saved in Settings, the trial can use a
     no-key build: `--allow-no-access-key`, Test channel only.
   - Baking the key is the owner's job:
     1. On Silvia, in a checkout of `launcher-handover`, put the key into `src/launcher.config.json`
        `accessKey`.
     2. Run `npm ci && npm run build:win`.
     3. Revert the file. Never commit the key.
   - I have not read `/root/slums-patch-access-key.txt`.
2. **User-name catch:** the Electron launcher always sends user `slums`.
   - After the nginx dev tier, `/launcher-test/` accepts only `slumsdev`, so **no Electron launcher
     can reach the Test channel**. It can't self-update to the hand-over build, and the hand-over
     can't fetch `launcher-test/tauri/launcher.json`.
   - Either run the Electron hand-over trial **before** the nginx change, or add a `slumsdev`
     retry to the hand-over build. That second option needs a decision; it is not implemented.
3. **Publishing the hand-over build:**

   ```
   node … publish.mjs --launcher <dist/win-unpacked> --out /srv/slums-patch/launcher-test [--allow-no-access-key]
   ```

   It has to come after Tauri 1.5.0 is in `launcher-test/tauri/`.

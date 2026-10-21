# Patch server: the dev access tier for Test and RC

The Tauri launcher finds out which channels a key opens by asking the server. It probes each
channel's `manifest.json`:

- a player key opens Live only;
- the dev key opens Live, Test (`/launcher-test/`) and RC (`/launcher-rc/`).

The launcher shows the channel picker only when a key opens more than one channel. Nothing in the
launcher decides who is a developer; nginx does.

The launcher sends a key as HTTP Basic auth. A player key uses the user name `slums`. If the server
refuses that, the launcher tries the user name `slumsdev`, which the dev key uses. It remembers which
name worked.

**Status:** these steps are written for the owner to run on 164. Nothing below has been applied, and
no key appears in this repo.

## What changes

| Path | Today | After |
| --- | --- | --- |
| `/` (Live, including the shared `/layers/`) | `slums` | `slums` or `slumsdev` |
| `/launcher-test/`, `/launcher-rc/` | `slums` (the player key) | `slumsdev` only |
| `tauri/launcher.json` in each channel (the Tauri self-update manifest) | n/a | Same rule as its channel. The existing `launcher.json` rule already makes it no-cache. |

The Test and RC folders read the shared layers through their `layers -> ../layers` symlinks. A
request for `/launcher-test/layers/...` therefore needs the dev key, and a request for `/layers/...`
needs either key. No layer data is copied.

## Steps on 164 (as root)

1. **Back up the live server block.**
   On 164, `sites-enabled/slums-patch` is a regular file, not a link. It also differs from
   `sites-available`. Edit the file in `sites-enabled` and nothing else. Keep the backup outside
   `sites-enabled`, because nginx loads every file in that folder.

   ```sh
   cp -p /etc/nginx/sites-enabled/slums-patch /root/slums-patch.nginx.bak-$(date +%Y%m%d-%H%M%S)
   cp -p /etc/nginx/slums-patch.htpasswd /root/slums-patch.htpasswd.bak-$(date +%Y%m%d-%H%M%S)
   ```

2. **Add the dev user.** Pick a new dev key; it must not be the player key. `htpasswd` asks for it.
   It never goes on a command line.

   ```sh
   htpasswd -B /etc/nginx/slums-patch.htpasswd slumsdev        # players file: slums + slumsdev
   htpasswd -B -c /etc/nginx/slums-patch-dev.htpasswd slumsdev  # dev-only file: slumsdev
   chown root:www-data /etc/nginx/slums-patch-dev.htpasswd && chmod 640 /etc/nginx/slums-patch-dev.htpasswd
   ```

   Type the same dev key both times. Use `-c` only for the new dev file: on the players file it
   would delete the `slums` user.

3. **Apply the server-block change.**
   - Prepared files: `/root/work/deploy/nginx-dev-channels/slums-patch.new` (full file) and
     `slums-patch.diff` (the change).
   - The diff adds two `location ^~` blocks, for `/launcher-test/` and `/launcher-rc/`. They use
     `auth_basic_user_file /etc/nginx/slums-patch-dev.htpasswd` and keep the same cache rules.
   - First compare `.current` with the live file. If they differ, merge the diff by hand.

   ```sh
   diff /root/work/deploy/nginx-dev-channels/slums-patch.current /etc/nginx/sites-enabled/slums-patch && \
     cp /root/work/deploy/nginx-dev-channels/slums-patch.new /etc/nginx/sites-enabled/slums-patch
   nginx -t && systemctl reload nginx
   ```

   The `.new` file is a copy of the parked branch's `docs-wip/slums-patch.new`
   (branch `ops-channels-electron-wip`).

4. **Check it from 164.** Paste the keys when prompted (`curl -u user` asks), so they stay out of the
   shell history:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -u slums    http://127.0.0.1:8090/manifest.json               # 200
   curl -s -o /dev/null -w '%{http_code}\n' -u slums    http://127.0.0.1:8090/launcher-rc/manifest.json   # 401
   curl -s -o /dev/null -w '%{http_code}\n' -u slumsdev http://127.0.0.1:8090/launcher-rc/manifest.json   # 200
   curl -s -o /dev/null -w '%{http_code}\n' -u slumsdev http://127.0.0.1:8090/manifest.json               # 200
   ```

5. **Rollback** (if anything misbehaves): copy the backups back and reload.

   ```sh
   cp -p /root/slums-patch.nginx.bak-* /etc/nginx/sites-enabled/slums-patch
   cp -p /root/slums-patch.htpasswd.bak-* /etc/nginx/slums-patch.htpasswd
   nginx -t && systemctl reload nginx
   ```

## Effect on existing launchers

- **Electron launchers (1.3.x/1.4.x)** with a player key on the Live feed: no change.
- **The owner's Electron launcher pointed at `/launcher-rc/` with the player key**: it starts
  getting 401 and shows "This server needs an access key". There are two fixes: enter the dev key
  in Settings (the Electron launcher always sends user `slums`, so its dev access needs the Tauri
  launcher), or reset its feed to Live.
- **Tauri launcher**: a player key sees Live only, and the dev key gets the Live/Test/RC picker.

## Publishing Tauri launcher builds per channel

Each channel folder carries its own Tauri update manifest. Publish with the dev tools, never by hand:

```sh
# test channel first, then rc, then live
node tools/publish.mjs --tauri-launcher "SlumsMS Launcher.exe" --signature "SlumsMS Launcher.exe.sig" \
  --version 1.5.1 --base-url https://slumspatch.asslorde.com/launcher-test/ --out /srv/slums-patch/launcher-test
```

This writes `tauri/1.5.1/SlumsMS-Launcher.exe` (immutable) and then `tauri/launcher.json`. The
launcher refuses an update whose download URL is not on the feed's own origin.

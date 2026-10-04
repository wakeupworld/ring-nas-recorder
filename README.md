# ring-nas-recorder

Saves Ring camera video to a NAS folder **without a Ring Protect subscription**.

Without Ring Protect, Ring does not store any recordings in its cloud, so there is
nothing to download. Instead this container listens for the same motion / doorbell
push notifications the Ring app receives, opens a live stream the moment one arrives,
and records it to MP4 with ffmpeg:

```
/recordings/
  Front Door/
    2026-10-03/
      2026-10-03_07-05-09_motion.mp4
      2026-10-03_07-12-44_ding.mp4
  Back Yard/
    2026-10-03/
      2026-10-03_22-00-00_continuous.mp4
```

It is built on [`ring-client-api`](https://github.com/dgreif/ring) (the library used by
homebridge-ring and ring-mqtt), runs as a single small container, and has no other
dependencies (no MQTT broker, Home Assistant or NVR). It runs locked down by default:
non-root, read-only root filesystem, all capabilities dropped, no published ports,
and no secrets in the app config. See [Security](#security).

## Read this first: limitations of live-stream recording

| Caveat | Why |
| --- | --- |
| Clips start roughly 3-8 seconds after motion | The notification has to reach the container and a live session has to be negotiated. Only Ring Protect gives you pre-roll. |
| Battery cameras drain faster | Each clip is a live-view session. Keep `CLIP_SECONDS` modest, and leave battery cameras out of continuous mode. |
| No new motion alerts while a stream is live | Ring cameras don't send motion notifications during live view, so one clip covers one event and the camera re-arms after `COOLDOWN_SECONDS`. |
| Concurrent streams are limited | Ring may refuse or drop parallel live sessions on one account. `MAX_CONCURRENT_STREAMS` (default 2) skips extra events instead of piling up sessions. |
| Live sessions last at most about 10 minutes | Ring ends them, so continuous mode records segments of `SEGMENT_SECONDS` (590 or less) with a gap of a few seconds between them. |
| Some settings block third-party streaming | Ring **End-to-End Encryption** must be off. **Modes** that disable Live View for a camera also block recording. **Motion Alerts** must be on for each camera (Ring app > Device > Motion Settings), otherwise no notifications reach the container. |
| Internet required | All Ring streaming goes through Ring's cloud, even when the NAS sits next to the camera. |

## Configuration

All settings are environment variables. None of them is secret.

| Variable | Default | Description |
| --- | --- | --- |
| `TZ` | UTC | Time zone for folder and file names, e.g. `America/Chicago`. |
| `CAMERAS` | all | Comma-separated camera names (as in the Ring app, case-insensitive) or ids. |
| `TRIGGERS` | `motion,ding` | What starts a clip: `motion`, `ding` (doorbells only), or both. Set it to an empty string for continuous-only mode. |
| `CLIP_SECONDS` | `45` | Length of each event clip (5-600). |
| `COOLDOWN_SECONDS` | `15` | Ignore new events for this long after a clip on the same camera. |
| `MAX_CONCURRENT_STREAMS` | `2` | Maximum number of simultaneous live sessions across all cameras. |
| `CONTINUOUS_CAMERAS` | – | Cameras to record continuously while `CONTINUOUS_SCHEDULE` is active. |
| `CONTINUOUS_SCHEDULE` | `off` | `off`, `always`, or windows such as `22:00-06:00,12:00-13:00`. Event triggers are paused for those cameras while the window is active. |
| `SEGMENT_SECONDS` | `300` | Length of each continuous segment (30-590). |
| `RETENTION_DAYS` | `30` | Delete clips older than N days. `0` keeps everything. |
| `MIN_FREE_GB` | `5` | Before each recording and hourly, delete the oldest clips until this much space is free. If space still can't be freed, skip recording. `0` disables this. |
| `MIN_CLIP_BYTES` | `50000` | Discard clips smaller than this (failed or refused streams). |
| `RING_REFRESH_TOKEN_FILE` | `/run/secrets/ring_refresh_token` | Optional bootstrap token file (Docker secret), read only while `/data/refresh-token` doesn't exist. |
| `RING_REFRESH_TOKEN` | – | Discouraged fallback for the same purpose; logs a warning. |
| `DRY_RUN` | `false` | Log what would be recorded without opening streams. |
| `DEBUG` | `false` | Verbose logging, including from `ring-client-api`. Tokens are still redacted. |
| `MOCK` | `false` | Use two simulated cameras and ffmpeg test video instead of Ring. |

Volumes:

- `/data` is app-private: the rotating refresh token (`refresh-token`, mode 0600) and
  the healthcheck heartbeat. **Losing it means logging in again.**
- `/recordings` holds the clips. Folders are created 0750 and files 0640
  (umask 027).

Retention and the free-space floor only ever delete regular `*.mp4` files inside
`/recordings`. They never follow symlinks or touch other files. A ZFS **quota** on the
recordings dataset is still the hard backstop: Datasets > Edit > Quota.

### Why the token file matters

Ring refresh tokens are single-use. Every authentication returns a new token, and
the old one stops working soon after. The token also carries the push-notification
registration. The container writes each new token atomically (temp file, fsync,
rename, mode 0600) to `/data/refresh-token`. If the log ever shows `Refresh token is
not valid`, run the login step again.

---

## Deploying on TrueNAS SCALE 25.10 (primary)

These steps target TrueNAS SCALE **25.10 (Goldeye)**, whose apps run on Docker. The
steps use pool name `tank`; replace it with your pool name.

### 1. Create the datasets and permissions

**Datasets > Add Dataset**:

1. **`tank/apps/ring-nas-recorder`** becomes `/data` and holds the token.
   Use **Preset: Generic** (POSIX permissions, so the 0600 token mode is enforced).
   Then open **Permissions > Edit** and set:
   - User `apps`, Group `apps`
   - Read/Write/Execute for the user only: mode **700**, nothing for group or other
   - Tick **Apply User** and **Apply Group**
2. **`tank/media/ring`** becomes `/recordings`. Use **Preset: SMB** if you want to
   browse the clips over the network, otherwise Generic. Open **Permissions > Edit**:
   - NFSv4 ACL (SMB preset): **Add Item**, User `apps`, **Modify**. For viewers, see
     [SMB access for viewers](#smb-access-for-viewers). Remove any `everyone@` entry
     with write access. Tick **Apply permissions recursively**, then **Save Access
     Control List**.
   - POSIX (Generic preset): owner `apps:apps`, mode **750**, recursive.
3. Recommended: set a **Quota** on `tank/media/ring` (e.g. 500 GiB) so the recorder
   can never fill the pool.

The container runs as 568:568 and has no root privileges, so it cannot fix
permissions itself. It refuses to start, logging which UID/GID can't write where, if
either mount isn't writable.

### 2. Get the image

**Option A (recommended): signed image from GHCR, pinned by digest.** CI builds,
tests and Trivy-scans every change, then publishes
`ghcr.io/wakeupworld/ring-nas-recorder` and signs it with cosign (keyless, GitHub
OIDC). Take the `@sha256:...` digest from the workflow run summary, or from
**GitHub > Packages > ring-nas-recorder**. If the package is private, make it public
there, or add GHCR credentials under **Apps > Configuration > Manage Container
Images**. Optionally verify the signature from any machine with cosign:

```sh
cosign verify ghcr.io/wakeupworld/ring-nas-recorder@sha256:<digest> \
  --certificate-identity-regexp '^https://github.com/wakeupworld/ring-nas-recorder/\.github/workflows/ring-nas-recorder\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Then pull it on TrueNAS: `sudo docker pull ghcr.io/wakeupworld/ring-nas-recorder@sha256:<digest>`.

**Option B: build locally** in **System > Shell**:

```sh
git clone https://github.com/wakeupworld/ring-nas-recorder.git /tmp/rnr
cd /tmp/rnr
sudo docker build -t ring-nas-recorder:latest .
```

In the app YAML use `image: ring-nas-recorder:latest` and `pull_policy: never`.

### 3. Log in to Ring (one time, writes the token file)

```sh
sudo docker run --rm -it --user 568:568 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --tmpfs /tmp \
  -v /mnt/tank/apps/ring-nas-recorder:/data \
  ghcr.io/wakeupworld/ring-nas-recorder@sha256:<digest> auth
```

Enter the Ring email and password (the password isn't echoed), then the 2FA code.
The token goes straight to `/mnt/tank/apps/ring-nas-recorder/refresh-token` (mode
0600, owner `apps`). The command prints only a short fingerprint, never the token, and
the password is not stored. Afterwards, **Ring app > Control Center > Authorized
Client Devices** shows `ring-nas-recorder`.

### 4. Install the app via YAML

1. Go to **Apps > Discover Apps**, click the **⋮** menu at the top right, and choose
   **Install via YAML**.
2. Name it `ring-nas-recorder` and paste
   [`deploy/truenas-app.yaml`](deploy/truenas-app.yaml).
3. Set the image digest, the two `/mnt/...` paths (`/data` must be the
   `tank/apps/ring-nas-recorder` dataset from step 1) and `TZ`, then click **Save**.

The YAML contains no secrets and already applies the hardening: `user: 568:568`,
`read_only`, a `noexec` tmpfs `/tmp`, `cap_drop: [ALL]`, `no-new-privileges`, CPU,
memory and PID limits, no `ports:`, a dedicated bridge network, and log rotation.
`restart: unless-stopped` brings it back after crashes and reboots. The image
healthcheck marks the app unhealthy if the heartbeat stalls for 3 minutes.

### 5. Verify

Open **Apps > Installed > ring-nas-recorder > Logs**. You should see:

```
INFO  Using refresh token from /data/refresh-token
INFO  Authenticating with Ring and discovering cameras...
INFO  Refresh token rotated and saved
INFO  Camera "Front Door" (id 123456) battery, triggers: motion+ding
INFO  Listening for events: 45s clips -> /recordings
```

Walk in front of a camera. A clip appears under `/mnt/tank/media/ring/<Camera>/<date>/`
shortly after.

### Updating

Change the digest in the app's YAML (**Edit**) to the newly published one and Save.
If you build locally, rebuild and then **Edit > Save** to recreate the container. The
token in `/data` is kept.

### Optional: write the clips to a Synology share instead

The container can run on TrueNAS while the files land on a Synology. Swap the
`/recordings` bind mount for a Docker NFS volume. Keep `/data` on TrueNAS.

On the Synology:
1. Enable NFS under **Control Panel > File Services > NFS**.
2. Open the shared folder's **Edit > NFS Permissions** and add the TrueNAS IP
   **only**, with Read/Write. For Squash, choose *Map all users to admin*, or use
   *No mapping* and make the folder writable by UID 568.

```yaml
    volumes:
      - /mnt/tank/apps/ring-nas-recorder:/data
      - synology-ring:/recordings
volumes:
  synology-ring:
    driver: local
    driver_opts:
      type: nfs
      o: addr=192.168.1.20,nfsvers=4.1,rw,soft,nosuid,nodev,noexec
      device: ":/volume1/ring"
```

Avoid SMB (`type: cifs`) volumes here: they require the share password in plain text
in the app YAML. To run the container **on** a Synology instead, create a project
under **Container Manager > Project > Create** with [`docker-compose.yml`](docker-compose.yml).

---

## Security

### What the container does and doesn't do

| Area | Measure |
| --- | --- |
| Secrets | No token in the YAML or environment. The `auth` command writes it to the 0700 data dataset as a 0600 file, owned by 568. Rotations are written atomically. Tokens, passwords and bearer values are redacted from all logs, including `ring-client-api` debug output and error stacks. A bootstrap token can also come from a Docker secret file. |
| Privileges | Runs as 568:568 (`USER` in the image and `user:` in the YAML). Read-only root filesystem, `noexec`/`nosuid` tmpfs for `/tmp`, `cap_drop: ALL`, `no-new-privileges`, PID, memory and CPU limits. |
| Network | No listening ports and no `ports:` mapping. Only outbound connections to Ring and Google push. |
| Image | Multi-stage build on `node:22-alpine3.24` pinned by digest. ffmpeg, tini and tzdata come from Alpine with pinned versions. Dependency install scripts are disabled (`npm ci --omit=dev --ignore-scripts`). npm, npx, corepack and yarn are removed from the runtime image. |
| Supply chain | Exact versions in `package.json` plus `package-lock.json`. CI (`.github/workflows/ring-nas-recorder.yml`, all actions pinned by commit SHA) runs the tests, an `npm audit` gate, a locked-down smoke test and a Trivy scan that fails on HIGH/CRITICAL findings. It publishes to GHCR with SBOM and provenance and signs with cosign. |
| Data | Camera names are sanitized (no `/`, `\`, `..`, control characters or leading dots, at most 80 characters), and every output path is checked to stay inside `/recordings`. Files are 0640 and folders 0750. Retention and the free-space floor bound disk use. |

Accepted dependency finding: `ip@2.0.1` (CVE-2024-29415 / GHSA-2p57-rm9w-gvfp, no
fixed release) comes in through `werift`, the WebRTC stack used by `ring-client-api`.
The bug is in `ip.isPublic()`/`isPrivate()`, which werift never calls. It only uses
`isV4`, `isV6`, `toBuffer`, `toString` and `isLoopback`. The finding is allowlisted by
ID in `scripts/audit-check.mjs` and `.trivyignore`, so any *other* advisory still
fails CI.

### Ring account

- **2FA**: Ring requires 2FA for logins. Prefer an authenticator app over SMS.
- **Dedicated shared user (recommended)**: create a separate Ring account (e.g.
  `ring-nas@yourdomain`) and invite it from the owner account under **Ring app >
  Control Center > Shared Users**. Log the recorder in with that account. If the
  token leaks, the attacker gets a shared user's access (live view, event list), not
  owner rights such as changing settings, removing devices or managing billing.
  Enable Motion Alerts for each camera in the *shared* account's app, because
  notifications follow that account's settings. If you have Ring Alarm, shared users
  can typically arm and disarm it; weigh that before sharing alarm access.
- **Revocation**: remove `ring-nas-recorder` under **Control Center > Authorized
  Client Devices**, then delete `/mnt/tank/apps/ring-nas-recorder/refresh-token`.
  Changing the Ring password also signs out all clients.
- Treat the data dataset like a password store: keep it out of SMB/NFS shares and
  out of replication targets you don't control.

### TrueNAS permissions

- `tank/apps/ring-nas-recorder` should be POSIX, owned `apps:apps`, mode 0700, and
  **never shared**.
- `tank/media/ring` gets `apps` with Modify, admins with Full Control, and viewers
  with Read only. Don't grant `everyone@` or `other` any access.
- Put a quota on the recordings dataset. Snapshots (Data Protection > Periodic
  Snapshot Tasks) protect clips against accidental or malicious deletion over SMB.

### SMB access for viewers

1. Create a group `ring-viewers` (**Credentials > Groups**) and add the people who may
   watch clips.
2. On `tank/media/ring` > **Edit ACL**, add Group `ring-viewers` with **Read**,
   inherited (Apply recursively).
3. Create the share under **Shares > SMB > Add**, path `/mnt/tank/media/ring`. Under
   **Advanced Options** tick **Export Read Only**. If admins need to delete clips,
   create a second, admin-only share without read-only instead.

### Network

The recorder only needs outbound internet:

- Ring API and auth over HTTPS (`oauth.ring.com`, `api.ring.com`, `app.ring.com`,
  `*.rings.solutions`)
- Google Firebase Cloud Messaging for push notifications (`mtalk.google.com`
  TCP 5228-5230, `*.googleapis.com`, `android.clients.google.com`)
- WebRTC media over UDP and TCP to Ring media servers on changing cloud IPs

A strict domain or IP allowlist therefore tends to break live streams. The useful
restriction is **blocking the container from your LAN**. The app YAML pins its
network to `172.30.250.0/24` for that purpose. TrueNAS 25.10 has no per-app firewall
UI, so add a post-init script under **System > Advanced Settings > Init/Shutdown
Scripts > Add**, with Type *Command*, When *Post Init*:

```sh
iptables -N RING-EGRESS 2>/dev/null; iptables -F RING-EGRESS; \
iptables -A RING-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN; \
iptables -A RING-EGRESS -d 10.0.0.0/8 -j DROP; \
iptables -A RING-EGRESS -d 172.16.0.0/12 -j DROP; \
iptables -A RING-EGRESS -d 192.168.0.0/16 -j DROP; \
iptables -D DOCKER-USER -s 172.30.250.0/24 -j RING-EGRESS 2>/dev/null; \
iptables -I DOCKER-USER -s 172.30.250.0/24 -j RING-EGRESS
```

Docker's embedded DNS resolves names through the host, so DNS keeps working. Check
the rules with `sudo iptables -L DOCKER-USER -n` after starting the app, because
Docker recreates its chains on restart, which is why this runs post-init. If your
router supports VLANs or per-host rules, blocking the NAS's app traffic to the LAN
there is equivalent and survives TrueNAS upgrades.

---

## Any other Docker host

```sh
cp .env.example .env               # TZ and options only, no secrets
mkdir -p data recordings && sudo chown 568:568 data recordings && chmod 700 data
docker compose build
docker compose run --rm ring-nas-recorder auth
docker compose up -d && docker compose logs -f
```

`docker-compose.yml` has the same hardening as the TrueNAS YAML, plus a commented-out
`secrets:` block if you'd rather bootstrap from a 0600 token file.

## Development and testing

```sh
npm ci --ignore-scripts && npm test && npm run audit
docker build -t ring-nas-recorder .
mkdir -p rec && sudo chown 568:568 rec
docker run --rm --read-only --cap-drop ALL --tmpfs /tmp -e MOCK=1 \
  -e RING_REFRESH_TOKEN=x -e CLIP_SECONDS=8 -e MOCK_EVENT_INTERVAL_SECONDS=5 \
  -e EXIT_AFTER_SECONDS=40 -v "$PWD/rec:/recordings" ring-nas-recorder
```

Mock mode simulates a doorbell and a camera. It runs the real recording, folder
layout, token persistence and permission code paths, with ffmpeg test video standing
in for the Ring stream.

## Alternatives considered

- **ring-mqtt** (+ go2rtc / Frigate) exposes each Ring camera as an RTSP stream. It is
  a good fit if you already run Home Assistant or MQTT. Recording clips still needs
  an automation that starts ffmpeg on motion, though. Frigate needs a continuous
  stream, which disables Ring motion alerts, drains batteries, and gets cut every
  10 minutes.
- **Scrypted** (Ring plugin + Scrypted NVR) offers a polished NVR UI and HomeKit
  integration. It is much heavier, the NVR is a paid add-on, and continuous
  recording has the same Ring streaming limits.
- **Recorded-event downloaders** (`camera.getEvents()` / `getRecordingUrl()`) need
  Ring Protect, so they don't apply here.

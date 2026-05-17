# TimeKeeper

TimeKeeper is a static browser app for project time tracking, planning, workouts, finances, wealth tracking, backups, and Strava-fed recovery/exertion data.

The deployed entrypoints remain:

- `index.html`
- `style.css`

Saved browser data stays compatible with the existing `localStorage` schema. No bundler or framework is required.

## Workspace layout

```text
TimeKeeper/
|- index.html
|- style.css
|- src/
|  |- main.mjs
|  |- shared/
|  |- features/
|  `- styles/
|- scripts/
|- tests/
|- assets/
`- archive/legacy/
```

## Development

Install dependencies:

```bash
npm install
```

Available commands:

```bash
npm run lint
npm run format
npm run format:check
npm run typecheck
npm run test:smoke
npm run check
```

## Safety gates

Use this sequence for structural refactors:

1. `node --check src/main.mjs`
2. `npm run lint`
3. `npm run format:check`
4. `npm run typecheck`
5. `npm run test:smoke`
6. Manual browser spot-check with persisted data loaded

The Playwright smoke suite currently covers:

- boot with saved data present
- section navigation
- project create/edit/delete
- timer and manual entry flows
- import/export
- workout logging
- finance and wealth rendering
- Strava fallback rendering
- backup/auto-sync unsupported state handling

## Focus Model

Timer focus is stored as a multiplier on each entry:

- `200%`: you plus two or more agents
- `150%`: you plus one agent
- `100%`: you actively focused on the project
- `50%`: an agent working without your active focus
- `25%`: an agent running while you are half-engaged or not monitoring it

The external focus blocker is toggled through `/focus/start` and `/focus/stop` when total paid focus crosses 50%. The app includes the paid focus percentage plus a `blockedSites` query parameter currently containing Reddit and YouTube domains.

### Enforcing Website Blocks

Browser JavaScript cannot block other tabs or OS traffic by itself. TimeKeeper sends focus webhooks, and the local helper enforces them by editing the OS hosts file.

On Windows:

1. Open PowerShell as Administrator.
2. For a one-off session, run `npm run focus:blocker` from this repo and keep that terminal open.
3. For normal desktop use, run `npm run focus:blocker:install` once from the Administrator shell. This installs a `TimeKeeper Focus Blocker` scheduled task that starts at Windows logon with elevated hosts-file access.
4. Start a paid timer above 50% focus. The helper adds a marked TimeKeeper block to the hosts file and flushes DNS.
5. Stop paid focus to remove the marked block.
6. To remove the background helper, run `npm run focus:blocker:uninstall` from an Administrator shell.

The helper only edits the section between `# TimeKeeper focus block START` and `# TimeKeeper focus block END`. Hosts-file blocking works for exact domains such as `reddit.com`, `www.reddit.com`, `youtube.com`, `music.youtube.com`, `youtu.be`, and `i.ytimg.com`; it is not a wildcard DNS filter. Add extra comma-separated domains with `TIMEKEEPER_FOCUS_EXTRA_SITES`. The helper exposes `http://127.0.0.1:8766/focus/status` for checking whether the desktop block is currently active.

For Android-phone-to-Windows-desktop blocking, install the helper in LAN mode:

```powershell
npm run focus:blocker:install -- -ListenOnLan
```

Then open `http://<this-PC-LAN-IP>:8766/` on the Android phone and use TimeKeeper from that address instead of GitHub Pages. The helper serves the same app and the `/focus/*` blocker endpoints from one origin, so the phone can start/stop the Windows desktop block without a popup or `127.0.0.1` confusion. If Windows prompts for firewall access, allow private networks.

When using the hosted HTTPS app, Chrome may deny background requests from the page to `127.0.0.1`. For hosted use, enable Auto Data Sync in TimeKeeper and install the helper with the backup folder:

```powershell
npm run focus:blocker:install -- -BackupDir "C:\path\to\your\TimeKeeperBackupFolder"
```

The helper watches `timekeeper-data.json` in that folder and applies the desktop block from the saved running timers, so no popup or browser-localhost bridge is needed. Timer start/stop/focus changes flush the backup immediately when Auto Data Sync is enabled.

## Backup And Sync

Auto sync is designed for a cloud-synced folder such as Google Drive, OneDrive, or Dropbox. Choose that folder from Import / Export -> Auto Data Sync.

Each successful backup writes:

- `timekeeper-data.json`: latest full data
- `timekeeper-manifest.json`: metadata for inspection
- `timekeeper-snapshots/timekeeper-data-<timestamp>.json`: versioned snapshots

The app keeps the newest 30 snapshots, writes after a short debounce, runs a periodic one-minute safety flush, and attempts a final flush when the page is hidden or closed. Use `Backup Now` for an immediate write and `Restore Latest Backup` to reload `timekeeper-data.json` from the selected folder.

## Refactor notes

- `index.html` now bootstraps `src/main.mjs` as a browser ES module.
- Shared helpers live under `src/shared/`.
- Extracted domain logic currently lives under `src/features/`.
- `style.css` is the stable root stylesheet and now imports organized CSS slices from `src/styles/`.
- Historical root-level snapshots and archives were moved into `archive/legacy/`.

## Strava feed publishing

This repo includes a GitHub Actions workflow that publishes a lightweight Strava JSON feed to `assets/strava.json`, which is rendered in the Workouts section of the app.

### Setup

1. Create a Strava API app and note the Client ID and Client Secret.
2. Generate a refresh token with the `activity:read_all` scope.
3. Add repository secrets in GitHub:
   - `STRAVA_CLIENT_ID`
   - `STRAVA_CLIENT_SECRET`
4. Store the refresh token in `_private/strava_token.json`.

```json
{
  "refresh_token": "your-refresh-token"
}
```

The workflow fetches all available activities by paging through the Strava API.

### Troubleshooting

If the workflow logs show `Missing Strava refresh token`, restore `_private/strava_token.json`. If the logs show `401 Unauthorized`, generate a fresh refresh token with `activity:read_all` scope and update `_private/strava_token.json`.

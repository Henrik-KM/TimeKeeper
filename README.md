# TimeKeeper

TimeKeeper is a static browser app for project time tracking, planning, workouts, finances, wealth tracking, backups, and Strava-fed recovery/exertion data.

The deployed entrypoints remain:

- `index.html`
- `style.css`

Saved browser data stays compatible with the existing `localStorage` schema. No bundler or framework is required.

The Dashboard includes an App Health panel that summarizes local data, backup/snapshot state, Strava feed freshness, desktop blocker status, and offline app cache status. It can also repair common local-data integrity problems such as duplicate IDs, orphaned entries, invalid focus values, and broken stopped-entry durations.

The Entries view supports project, search, and custom date-range filters; stopped entries can be edited, split, or duplicated after the fact, and exported visible CSVs use the currently filtered rows. A grouped summary CSV is also available for client/project billing checks.

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

New timers default to `100%`; focus is explicit and does not automatically decrease when multiple timers are running.

Manual entries can also carry focus. If start/end times are supplied, TimeKeeper stores the wall-clock range and multiplies it by the selected focus percentage to calculate effective tracked time.

The timer page shows pinned and recent project/description/focus combinations as quick-start chips so repeated work can be restarted with one click. Use `Pin Timer` to save the currently selected project, description, and focus as a persistent preset.

Running timers warn when they look forgotten, including timers that started before today or have been active for four or more wall-clock hours.

The external focus blocker is toggled through `http://127.0.0.1:8766/focus/start` and `/focus/stop` when total paid focus crosses 50%. The app includes the paid focus percentage plus a `blockedSites` query parameter containing the app-configured blocked domains.

### Enforcing Website Blocks

Browser JavaScript cannot block other tabs or OS traffic by itself. TimeKeeper sends focus webhooks, and the local helper enforces them by editing the OS hosts file.

On Windows:

1. Open PowerShell as Administrator.
2. For a one-off session, run `npm run focus:blocker` from this repo and keep that terminal open.
3. To verify the desktop can actually edit and restore the hosts file, run `npm run focus:blocker:self-test` from the Administrator shell. This temporarily writes a harmless managed block, removes it, restores the original hosts file, and reports JSON.
4. For normal desktop use, run `npm run focus:blocker:install` once from the Administrator shell. This installs a `TimeKeeper Focus Blocker` scheduled task that starts at Windows logon with elevated hosts-file access.
5. Start a paid timer above 50% focus. The helper adds a marked TimeKeeper block to the hosts file and flushes DNS.
6. Stop paid focus to remove the marked block.
7. To remove the background helper, run `npm run focus:blocker:uninstall` from an Administrator shell.

The helper only edits the section between `# TimeKeeper focus block START` and `# TimeKeeper focus block END`. Hosts-file blocking works for exact domains such as `reddit.com`, `www.reddit.com`, `youtube.com`, `music.youtube.com`, `youtu.be`, and `i.ytimg.com`; it is not a wildcard DNS filter. Use Edit Blocked Sites in the running timer panel to change the app's blocked-domain list. App-triggered blocks replace the helper defaults with that configured list. For helper-only/manual calls, add extra comma-separated defaults with `TIMEKEEPER_FOCUS_EXTRA_SITES`. The helper exposes `http://127.0.0.1:8766/focus/status` for checking whether the desktop block is currently active and `http://127.0.0.1:8766/focus/self-test` for a write/remove/restore permission diagnostic. The running timer panel includes Check Desktop Blocker, Self-Test Blocker, and Test Blocker controls. The Dashboard App Health panel also includes Check Blocker and Self-Test actions.

When using the hosted HTTPS app, Chrome may deny direct background requests to `127.0.0.1`. TimeKeeper sends the focus webhook silently and never opens a visible localhost tab.

### Android Phone To Windows Desktop Blocking

`127.0.0.1` always means the current device. If TimeKeeper is running on Android from GitHub Pages, a localhost webhook can reach MacroDroid on the phone, but it cannot reach the Windows helper on the desktop.

For cross-device blocking without a paid service, use the GitHub focus bridge:

1. Create a fine-grained GitHub token for the GitHub Pages repository with Contents read/write access.
2. In TimeKeeper, start a timer or open App Health, then choose `Focus Bridge`.
3. Set the repository, branch, state file path such as `assets/timekeeper-focus-state.json`, and the token.
4. TimeKeeper will publish a tiny focus-state JSON whenever paid focus crosses the 50% threshold and periodically while active. The token is stored in browser localStorage only, not in `timekeeperDataPro` exports/backups.
5. On Windows, configure the helper to poll that file:

```powershell
[Environment]::SetEnvironmentVariable(
  'TIMEKEEPER_FOCUS_STATE_URL',
  'https://api.github.com/repos/OWNER/REPO/contents/assets/timekeeper-focus-state.json?ref=main',
  'User'
)

# Only needed if the repository or state file is private.
[Environment]::SetEnvironmentVariable('TIMEKEEPER_FOCUS_STATE_TOKEN', 'github_pat_...', 'User')
```

Restart the scheduled task, or reinstall it with `npm run focus:blocker:install`. The helper also accepts a one-off CLI argument:

```bash
npm run focus:blocker -- --state-url="https://api.github.com/repos/OWNER/REPO/contents/assets/timekeeper-focus-state.json?ref=main"
```

Remote focus states expire after 15 minutes in the app and are treated as stale by the helper, so an abandoned phone/browser session clears the desktop block instead of leaving the PC offline indefinitely.

## Codex Usage Bridge

TimeKeeper can import Codex desktop work as 50% project time. The Android/GitHub Pages app cannot read Windows Codex logs directly, so each Windows desktop runs a small scheduled helper that scans local Codex session JSONL files, publishes sanitized usage records to a GitHub inbox, and exits.

The helper never publishes prompts, tool output, or full local paths. It publishes repo/thread metadata, active timestamps, and effective seconds only. It also ignores Codex activity before the local start of the current day, so older sessions that are already accounted for do not get imported again.

Setup:

1. In TimeKeeper, open Import / Export -> Codex Integration.
2. Keep Codex repos under `GitHub/<TimeKeeper project>/<repo>`, for example `GitHub/IFLAI/VWR-AutoInv` or `GitHub/Anders/particle_iden`.
3. Add a fine-grained GitHub token with Contents read/write access and choose `Publish Config`. TimeKeeper publishes the active project names, and the helper only tracks folders whose parent folder is one of those TimeKeeper projects. A folder such as `GitHub/Polish/...` is ignored unless `Polish` exists as an active TimeKeeper project.
4. On each Windows desktop, set the same token for the helper:

```powershell
[Environment]::SetEnvironmentVariable('TIMEKEEPER_CODEX_TOKEN', 'github_pat_...', 'User')
```

5. Install the scheduled task once from this repo:

```powershell
npm run codex:bridge:install
```

The task runs at logon and every 5 minutes, scans only today's changed Codex session files under `%USERPROFILE%\.codex\sessions`, writes one file per desktop under `assets/timekeeper-codex-inbox/`, and exits. To run it manually:

```bash
npm run codex:bridge
```

To uninstall the scheduled task:

```powershell
npm run codex:bridge:uninstall
```

## Backup And Sync

Auto sync is designed for a cloud-synced folder such as Google Drive, OneDrive, or Dropbox. Choose that folder from Import / Export -> Auto Data Sync.

Each successful backup writes:

- `timekeeper-data.json`: latest full data
- `timekeeper-manifest.json`: metadata for inspection
- `timekeeper-snapshots/timekeeper-data-<timestamp>.json`: versioned snapshots

The app keeps the newest 30 snapshots, writes after a short debounce, runs a periodic one-minute safety flush, and attempts a final flush when the page is hidden or closed. Use `Backup Now` for an immediate write, `Verify Backup` to write and read back the latest file, manifest, and snapshot, `Restore Latest Backup` to reload `timekeeper-data.json`, or Snapshot History to inspect and restore a specific timestamped snapshot from the selected folder.

Before writing, TimeKeeper checks the selected folder's latest backup revision and data timestamp. If the folder contains newer data, auto-sync pauses instead of overwriting it. Restore the latest backup first, or use `Backup Now` and confirm the overwrite intentionally.

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

The workflow fetches all available activities by paging through the Strava API. If Strava rejects a refresh but `assets/strava.json` already contains activities, the script preserves the existing feed so the app does not go blank.

### Free export import

Strava users can still download their own activity archive for free. To update TimeKeeper without an API subscription, download the Strava export zip and run:

```bash
python scripts/import_strava_export.py path/to/strava-export.zip
```

The importer reads `activities.csv`, merges it with any existing `assets/strava.json` details, applies local exertion overrides, and writes the same JSON feed used by the app. Commit and push `assets/strava.json` afterward to publish it to GitHub Pages.

From GitHub Pages, you can also open Import / Export and choose either a TimeKeeper-compatible Strava JSON file or the extracted `activities.csv` from Strava's free data export. Browser imports are stored in local cache immediately, so the Workouts page does not go blank while API access is unavailable.

### Troubleshooting

If the workflow logs show `Missing Strava refresh token`, restore `_private/strava_token.json`. If the logs show `401 Unauthorized`, generate a fresh refresh token with `activity:read_all` scope and update `_private/strava_token.json`, or use the free export import path instead.

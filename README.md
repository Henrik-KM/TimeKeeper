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

The external focus blocker is toggled through `http://127.0.0.1:8766/focus/start` and `/focus/stop` when total paid focus crosses 50%. The app includes the paid focus percentage plus a `blockedSites` query parameter currently containing Reddit and YouTube domains.

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

The workflow fetches all available activities by paging through the Strava API.

### Troubleshooting

If the workflow logs show `401 Unauthorized`, verify that the refresh token has `activity:read_all` scope and that the secrets match your Strava app credentials.

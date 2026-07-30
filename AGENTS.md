# AGENTS.md

Instructions for automated coding agents working in this repository.

## Repository Identity

TimeKeeper is a static browser app for time tracking, project planning, workouts,
finances, wealth tracking, Strava-backed exertion data, backups, and local
desktop helper integrations.

The deployed entrypoints are intentionally simple:

- `index.html`
- `style.css`
- browser ES modules under `src/`

There is no bundler or frontend framework. Do not add one unless the user
explicitly asks for that architectural change.

## First Principles

- Read the current repo before editing. This app has a lot of behavior in
  `src/main.mjs`, and many surfaces share the same underlying data.
- Preserve existing browser data. Saved data is stored in `localStorage` under
  `timekeeperDataPro`; schema changes must be additive and normalized through
  defaults/migration code.
- Treat mobile as a first-class product surface. Changes to timer, workouts,
  finances, wealth, sync, entries, and charts should be usable from a phone
  without falling back to desktop-only controls.
- Optimize for operator ergonomics, not just technical correctness. The app is
  used as a daily command center, so quick actions, clear next actions, and
  low-friction recovery paths matter.
- Keep edits scoped. Avoid broad rewrites of `src/main.mjs` unless the task
  truly requires a structural extraction.
- Preserve explicit side-effect boundaries. Do not install scheduled tasks,
  edit the OS hosts file, publish GitHub config/inbox data, delete data, or
  overwrite backups unless the user clearly asks for that action.

## Project Map

- `index.html`: stable DOM shell and section IDs. Historical IDs matter:
  `todo` is the Workouts section and `grocery` is the Finances section.
- `style.css`: stable root stylesheet that imports CSS slices from
  `src/styles/`.
- `src/main.mjs`: app bootstrap, state normalization, rendering, event wiring,
  mobile sheets, timer flows, finances, backup/sync, Codex integration, and
  cross-feature orchestration.
- `src/shared/runtime-helpers.mjs`: shared date, duration, project planning,
  pacing, and formatting helpers.
- `src/shared/ui.mjs`: shared modal, confirm, and toast helpers.
- `src/features/workouts/runtime.mjs`: workout intensity, weekly fitness, and
  workout data normalization.
- `src/features/wealth/core.mjs`: wealth history normalization and projection
  helpers.
- `src/features/strava/`: Strava scoring and free export import logic.
- `scripts/`: local helpers for the static server, focus blocker, Codex usage
  bridge, Strava import, and Windows scheduled task installers.
- `assets/`: published/runtime data such as `strava.json`, focus/Codex config,
  and Codex inbox files.
- `tests/unit/`: Node unit tests for pure helpers and local helper logic.
- `tests/smoke/timekeeper.spec.js`: Playwright coverage for browser workflows,
  mobile behavior, sync, focus blocker integration, Codex bridge flows, Strava,
  workouts, finances, and project planning.

## Environment And Commands

This repo is commonly edited on Windows in PowerShell. Prefer `npm.cmd` over
`npm` so execution is not blocked by PowerShell script policy.

Install dependencies:

```powershell
npm.cmd install
```

Common checks:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run test:unit
npm.cmd run test:smoke
```

Focused mobile smoke check:

```powershell
npm.cmd run test:smoke -- --grep "mobile"
```

Prettier check for files you touched:

```powershell
npm.cmd exec -- prettier --check AGENTS.md src/main.mjs src/styles/features.css tests/smoke/timekeeper.spec.js
```

Full check:

```powershell
npm.cmd run check
```

If full `format:check` reports unrelated pre-existing formatting drift, do not
mix that cleanup into the current change. Format and check the files you touched
and clearly report the broader drift.

The Playwright smoke suite starts `node scripts/static-server.mjs 4173`
automatically. For manual browser checks, start that same server rather than
adding a dev-server dependency.

## Formatting And Code Style

- Use 2-space indentation, LF line endings, UTF-8, final newline.
- Prettier settings: single quotes, semicolons, no trailing commas.
- Keep source in plain JavaScript ES modules.
- Prefer existing helper APIs over ad hoc parsing or duplicate math.
- Use DOM APIs and `textContent` for user-provided strings. Avoid `innerHTML`
  for dynamic content unless the markup is fully controlled and reviewed.
- Add comments only for non-obvious logic.
- Do not add generated files, `test-results/`, `playwright-report/`,
  `node_modules/`, or local browser profiles.

## Data Safety

TimeKeeper data is local-first and user-owned. Be conservative.

- When `.timekeeper-private/codex-context.json` exists, it is an explicitly
  user-authorized, local-only product-development context. Read it when actual
  TimeKeeper usage can inform the task, summarize patterns instead of repeating
  private entry descriptions unnecessarily, and never stage or commit it.
- Add new saved fields through defaulting/normalization so older exports still
  load.
- Keep import/export compatibility with `timekeeperDataPro`.
- Do not erase unknown fields during import, migration, repair, or backup flows
  unless the existing repair behavior explicitly owns them.
- Keep tokens out of exported app data. The Codex and focus integrations store
  sensitive tokens separately from normal TimeKeeper exports.
- Never inspect, print, commit, or modify secrets under `_private/` unless the
  user explicitly asks and the task requires it.
- Treat `assets/strava.json`, `assets/timekeeper-codex-config.json`, and
  `assets/timekeeper-codex-inbox/*` as published/runtime data. Modify them only
  when the task is specifically about Strava publishing, Codex import, or the
  corresponding integration.
- Backup/sync code must never overwrite newer backup data silently. Preserve the
  existing conflict/restore/verify flow.

## Side-Effect Boundaries

Some scripts intentionally touch the host machine or publish data. Do not run
them casually.

- `npm.cmd run focus:blocker`: starts a local helper that can edit the Windows
  hosts file when run with sufficient permissions.
- `npm.cmd run focus:blocker:self-test`: temporarily writes and restores a
  managed hosts-file block.
- `npm.cmd run focus:blocker:install` and `focus:blocker:uninstall`: change
  Windows scheduled tasks.
- `npm.cmd run codex:bridge`: scans local Codex session files and may publish a
  sanitized inbox if configured.
- `npm.cmd run codex:bridge:install` and `codex:bridge:uninstall`: change
  Windows scheduled tasks.
- Strava scripts and workflows may update published activity data.

When a task is read-only or exploratory, keep it read-only.

## Domain Guidance

### Timer And Planning

- Focus factor is explicit user intent. Do not auto-downgrade focus because
  multiple timers are running.
- Keep `focusFactor`, `manualFactor`, and effective duration behavior aligned
  for timers, manual entries, quick logs, edits, splits, duplicates, and mobile
  controls.
- Running timers must remain recoverable: pause/resume, edit, stop, stale-timer
  warnings, undo/history, and mobile Now bar behavior all matter.
- Planning semantics are product-sensitive:
  - `requiredDailyPace` is deadline pace.
  - `weeklyCommitmentHours` is the weekly commitment.
  - `recommendedToday` is today's catch-up recommendation.
  - Recommendation surfaces should use portfolio-adjusted
    `recommendedRemainingToday` when available so the dashboard, timer hints,
    dropdowns, and mobile Today panel agree.
- Preserve raw per-project pacing as diagnostics even when recommendation copy
  uses portfolio-level credit.

### Workouts

- The Workouts UI still uses the historical section id `todo`; do not rename it
  without handling routing, tests, and saved shortcuts.
- Use `ensureWorkoutData()` and `applyWorkoutDefaults()` when reading or
  mutating workout state.
- Preserve preset behavior, custom intensity parsing, weekly points, pause
  state, weekend boost, and Strava-derived exertion.
- Strava feed failures should degrade gracefully to cached or existing data; the
  Workouts page should not go blank.
- Mobile workout flows should support quick logging, a structured log sheet,
  date selection, intensity selection, and clear next-action copy.

### Finances And Wealth

- The Finances UI still uses the historical section id `grocery`; do not rename
  it without handling routing and tests.
- Financial copy and calculations generally use SEK.
- Preserve weekly, monthly, and biannual budget buckets, carry values, archived
  purchases, recurring monthly payments, and wealth history.
- Shared purchase logic should keep budget accounting, repeat purchases, archive
  behavior, and mobile quick actions consistent.
- Wealth chart changes must remain readable on mobile. Verify canvas sizing and
  horizontal overflow behavior in a phone viewport.
- Do not collapse finances and wealth into one data model just because they
  share a screen. They answer different user questions.

### Mobile UX

- Mobile Today is the daily command center. Prefer surfacing the next useful
  action over adding another deep desktop-only control.
- The mobile Now bar must expose useful running timer controls without forcing a
  trip to the Timer section.
- Use mobile bottom sheets/modals for structured phone flows. Keep forms short,
  labels explicit, and touch targets stable.
- Preserve bottom navigation, More menu routing, undo tray placement, mobile
  chart summaries/details, sync status, and hash shortcuts.
- Avoid visible explanatory tutorial text in the app. Controls should be clear
  through labels, grouping, state, and placement.
- Test at phone widths when changing layout. Text must not overlap, controls
  must not shift unexpectedly, and primary actions must remain reachable.

### Security And Browser Safety

- Render saved names, descriptions, clients, notes, workout names, and imported
  feed content as inert text.
- Keep existing XSS smoke coverage green when touching rendering.
- Never expose GitHub, Strava, backup, or local helper tokens in exports,
  logs, DOM text, or committed files.
- Hosted HTTPS pages may not be able to call `127.0.0.1` helpers. Maintain
  graceful fallback/status behavior.

## Testing Expectations

Choose checks based on risk:

- Documentation-only: inspect diff and, if formatted by tooling, run a scoped
  Prettier check.
- Pure helper change: run `npm.cmd run test:unit`, `npm.cmd run lint`, and
  `npm.cmd run typecheck`.
- Browser behavior change: run relevant Playwright grep, then the full smoke
  suite if the touched surface is shared.
- Mobile UI change: run `npm.cmd run test:smoke -- --grep "mobile"` and inspect
  the relevant viewport manually or with Playwright when layout risk is high.
- Timer/planning change: run unit tests plus smoke tests covering daily targets,
  recommendations, quick timers, manual entries, and timer controls.
- Workouts/finances/wealth change: run the smoke coverage for those sections and
  any mobile Today quick-action tests.
- Focus blocker, Codex bridge, backup/sync, or service worker change: run the
  related unit/smoke tests and verify side effects are mocked or explicitly
  authorized.

Before pushing, prefer:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run test:unit
npm.cmd run test:smoke
```

Also run a scoped Prettier check for changed source/test/docs files.

## Git Workflow

- Start by checking `git status --short --branch`.
- Do not revert or overwrite user changes you did not make.
- Stage only the intended files.
- Scheduled or automated commits may advance `origin/main`; fetch/rebase before
  pushing if the remote moved.
- Never force-push `main`.
- Use `--force-with-lease` only for a branch you own and only after a rebase
  makes that branch diverge.
- If the user asks to push with no PR, push directly and do not open a PR.

## Agent Handoff Checklist

Before handing work back:

- Summarize the user-visible behavior changed.
- List the files changed.
- List validation commands run and whether they passed.
- Call out any checks not run and why.
- Confirm whether anything was pushed, and to which branch/commit.

# Codex analysis measurement model

The deep Codex analysis page is available from the Codex section in
TimeKeeper and directly at `codex-analysis.html`. It reads the same browser
local `timekeeperDataPro` data as the main app and does not create a second
entry store.

## Measurement definitions

The page keeps three quantities separate:

1. **Active time**: wall-clock seconds attributed to Codex model activity.
2. **Effective time**: TimeKeeper credited time after model, effort,
   repository, and delegation policy weights.
3. **Quota usage**: positive percentage-point changes in an observed Codex
   limit window.

Quota usage is not tokens, cost, or billing. The imported records do not
consistently expose exact billable token consumption, so the page never
estimates it from elapsed time or model names.

The selected range's full active and effective totals are independent from
quota-history coverage. Efficiency denominators use only activity overlapping
actual quota snapshots. A session can therefore contribute to full-range time
without contributing to measured efficiency.

## Metrics and controls

- **Usage / active hour**: quota percentage points divided by measured active
  hours. Lower is better.
- **Effective hours / usage point**: measured credited hours divided by quota
  percentage points. Higher is better.
- **Focus conversion**: effective seconds divided by active seconds.
- **Usage share**: a model's attributed share of measured quota change.
- **Subagent share**: the portion of model active time classified as delegated
  work.

The page supports 24-hour, 7-day, 30-day, and 90-day ranges. Where the data
exists, the quota-window selector supports both primary and secondary windows.
Model, effort, and project filters, minimum measured-time and quota-point
thresholds, unknown-row visibility, sortable tables, charts, model-trend
filters, and CSV export all operate on the displayed breakdowns without
changing the overall totals.

The model trend view groups activity by model, reasoning effort, and Fast mode.
It reports full-range effective hours and measured quota efficiency by
session-start day. Fast mode is `on`, `off`, or `unknown`; older entries that do
not carry the bridge's Fast-mode field remain explicitly unknown. Trend rows
with fewer than two sessions, less than 0.5 measured active hours, or fewer
than two quota intervals are marked as low sample rather than treated as model
rankings.

## Attribution

The scheduled sampler records primary and secondary limit windows every ten
minutes. Unchanged states are compressed to hourly heartbeats, while state
changes are retained immediately. The history is bounded to 90 days.

The analytics engine:

1. sorts snapshots chronologically;
2. treats small reset-time timestamp jitter as the same quota window;
3. rejects reset transitions, negative deltas, anomalous jumps, and gaps
   longer than three hours;
4. finds imported Codex sessions overlapping each positive quota delta;
5. allocates the delta in proportion to overlapping model active time;
6. aggregates the result by model, model and effort, model/effort/Fast mode,
   effort, project, parent/subagent role, and daily model trend.

Allocation is conserved: the model breakdown sums to the attributed quota
points. Quota with no overlapping activity remains explicitly unattributed.
Mixed-model sessions contain aggregate model durations without exact per-model
timestamps, so their allocation is proportional and receives a lower
confidence qualification.

## Repository mapping audit

The main Codex page includes a repository mapping audit populated by the
desktop bridge. It lists every detected session path in the bridge lookback,
the resolved TimeKeeper project, session count, last-seen time, and whether the
match was automatic, custom, stale, or missing. Published audit paths are
sanitized to relative forms such as `GitHub/IFLAI/repository` or
`Documents/RiskNav`; the full Windows cwd is not included in the inbox.

An unknown row can be mapped by repository name or by a normalized path
substring. Saving a rule keeps it in the browser configuration and publishes it
through the existing Codex config publisher, so the desktop bridge uses the
same rule on its next run. Explicit rules also resolve unfamiliar GitHub parent
folders when the normal TimeKeeper project-folder match is unavailable.

## Historical backfill

The one-time backfill command can inspect bounded Git history of
`assets/timekeeper-codex-inbox/*.json`:

```text
node scripts/codex-usage-history.mjs --backfill-days=30
```

It reads actual historical `usageLimits` snapshots, compresses them through the
same merge path, preserves reset boundaries, and records a `backfill` metadata
object in the published history. Normal scheduled runs do not scan Git
history; they only sample the current inbox files.

The current one-time recovery found 4,697 usable candidates and compressed them
to 675 samples covering 23 July 2026 through 13 August 2026. Earlier inbox
commits did not contain usable `usageLimits` data, so the backfill must not
claim more than that recovered interval. A future run should preserve the
recorded recovery metadata rather than silently invent older values.

## Confidence and limitations

Confidence considers measured active time, quota points, and the number of
attributed intervals. Sparse history displays collecting or partial language.
Low-confidence differences must not be treated as established model rankings.
The page also reports skipped gaps, anomalous deltas, reset transitions,
unknown-model share, mixed-model share, and quota attribution coverage so that
small comparisons can be judged in context.

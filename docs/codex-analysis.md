# Codex analysis measurement model

The Codex analysis page separates three quantities that were previously mixed together:

1. **Active time**: wall-clock seconds attributed to Codex model activity.
2. **Effective time**: TimeKeeper's credited time after model, effort, repository and delegation policy weights.
3. **Quota usage**: percentage-point changes in the observed Codex limit window.

The first implementation deliberately labels quota use as percentage points rather than tokens. Codex currently exposes a limit-window percentage in the local session/status data, while exact billable token consumption is not consistently available in the TimeKeeper import records.

## Metrics

- **Usage / active hour**: quota percentage points divided by model active hours. Lower is better.
- **Effective hours / usage point**: credited hours divided by quota percentage points. Higher is better.
- **Focus conversion**: effective seconds divided by active seconds.
- **Usage share**: the model's attributed percentage of measured quota change.
- **Subagent share**: the portion of model active time classified as delegated/subagent work.

## Attribution

The sampler records the current primary and secondary limit windows every ten minutes, while compressing unchanged samples to an hourly heartbeat. The analytics engine then:

1. sorts snapshots chronologically;
2. rejects reset transitions, negative deltas, anomalous jumps and gaps longer than three hours;
3. finds imported Codex sessions overlapping each positive quota delta;
4. allocates the delta in proportion to overlapping model active time;
5. aggregates the result by model, model × effort, effort, project and role.

A mixed-model session contains aggregate model durations but no exact per-model timestamps. Its quota is therefore allocated proportionally within the session. The page exposes low, medium and high confidence labels so small or weakly measured differences are not presented as established rankings.

## Current integration state

The initial page is available at `codex-analysis.html`. It reads imported Codex entries from the same browser's `timekeeperDataPro` localStorage and quota history from `assets/timekeeper-codex-usage-history.json`.

The next integration step is to add a clear **Deep analysis** action to the existing Codex page and decide whether the analysis should remain a dedicated route or become embedded tabs inside the current page.

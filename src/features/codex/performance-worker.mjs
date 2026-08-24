import {
  buildCodexAnalytics,
  selectTopCodexModelPerformance
} from './analytics.mjs';

self.addEventListener('message', (event) => {
  const payload = event.data || {};
  try {
    const rangeDays = Array.isArray(payload.rangeDays)
      ? payload.rangeDays
      : [payload.rangeDays];
    const ranges = {};
    rangeDays.forEach((range) => {
      const analytics = buildCodexAnalytics({
        entries: payload.entries,
        projects: payload.projects,
        usageHistory: payload.usageHistory,
        rangeDays: range,
        now: payload.now,
        windowKey: payload.windowKey
      });
      ranges[String(range)] = {
        analytics,
        row: selectTopCodexModelPerformance(analytics.byModelEffort)
      };
    });
    self.postMessage({
      requestId: payload.requestId,
      ranges
    });
  } catch (error) {
    self.postMessage({
      requestId: payload.requestId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

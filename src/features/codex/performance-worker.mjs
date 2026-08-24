import {
  buildCodexAnalytics,
  selectTopCodexModelPerformance
} from './analytics.mjs';

self.addEventListener('message', (event) => {
  const payload = event.data || {};
  try {
    const analytics = buildCodexAnalytics({
      entries: payload.entries,
      projects: payload.projects,
      usageHistory: payload.usageHistory,
      rangeDays: payload.rangeDays,
      now: payload.now,
      windowKey: payload.windowKey
    });
    self.postMessage({
      requestId: payload.requestId,
      row: selectTopCodexModelPerformance(analytics.byModelEffort),
      measurementState: analytics.measurementState,
      coverage: analytics.coverage
    });
  } catch (error) {
    self.postMessage({
      requestId: payload.requestId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

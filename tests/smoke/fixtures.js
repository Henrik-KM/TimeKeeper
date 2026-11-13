const { test: base, expect } = require('@playwright/test');

const test = base.extend({
  serviceWorkers: 'block',
  context: async ({ context }, use) => {
    // Browser tests must never change the operator's desktop blocker state.
    await context.route('http://127.0.0.1:8766/**', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, active: false, blockedSites: [] })
      })
    );
    await use(context);
  }
});

module.exports = { test, expect };

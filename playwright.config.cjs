const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/smoke',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true
  },
  webServer: {
    command: 'node scripts/static-server.mjs 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 15000
  }
});

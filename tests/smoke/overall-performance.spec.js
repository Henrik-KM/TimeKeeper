const { expect, test } = require('./fixtures');

async function seedHistory(page, count = 10000) {
  await page.addInitScript((entryCount) => {
    if (localStorage.getItem('timekeeperDataPro')) return;
    const now = Date.now();
    const projects = Array.from({ length: 8 }, (_, index) => ({
      id: 'project-' + index,
      name: 'Project ' + index,
      budgetHours: 10000,
      hourlyRate: 100 + index * 10,
      startDate: '2025-01-01',
      deadline: '2027-12-31',
      createdAt: '2025-01-01T09:00:00Z',
      ...(index % 2 ? { scheduleType: 'weekly', weeklyExpectedHours: 10 } : {})
    }));
    const entries = Array.from({ length: entryCount }, (_, index) => {
      const offset = ((index * 1543) % entryCount) + 1;
      return {
        id: 'history-' + index,
        projectId: 'project-' + (index % 8),
        description: 'Session ' + (index % 40),
        startTime: new Date(now - offset * 1800000).toISOString(),
        endTime: new Date(now - offset * 1800000 + 600000).toISOString(),
        createdAt: new Date(now - offset * 1800000).toISOString(),
        duration: 600,
        elapsedSeconds: 600,
        focusFactor: 1,
        manualFactor: 1,
        isRunning: false
      };
    });
    localStorage.setItem(
      'timekeeperDataPro',
      JSON.stringify({
        projects,
        entries,
        usagePreferences: { groupEntries: false }
      })
    );
  }, count);
}

async function navigate(page, section) {
  return page.evaluate(async (id) => {
    const start = performance.now();
    const item = /** @type {HTMLElement} */ (
      document.querySelector('#navList li[data-section="' + id + '"]')
    );
    item.click();
    const blockingMs = performance.now() - start;
    await new Promise((resolve) =>
      requestAnimationFrame(() => window.setTimeout(resolve, 0))
    );
    return { section: id, blockingMs };
  }, section);
}

for (const width of [412, 1280]) {
  test(
    'navigation and charts stay bounded with long history at ' + width + 'px',
    async ({ page }) => {
      test.setTimeout(60000);
      await page.setViewportSize({ width, height: 915 });
      await page.route('https://**', (route) => route.abort());
      await seedHistory(page);
      const session = await page.context().newCDPSession(page);
      await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.goto('/#dashboard');
      await expect(page.locator('#todayCommandPanel')).toBeVisible();
      expect(await page.evaluate(() => window['Chart'].version)).toBe('4.6.1');
      await expect(page.locator('#timerProjectPro option')).toHaveCount(0);
      const samples = [];
      let expectedChartCount = null;
      for (let visit = 0; visit < 3; visit += 1) {
        const reports = await navigate(page, 'analytics');
        samples.push(reports);
        expect(reports.blockingMs).toBeLessThan(800);
        const chartState = await page.evaluate(() => {
          const chartApi = window['Chart'];
          const ids = Object.keys(chartApi.instances);
          const worked = chartApi.getChart('hoursByProjectChart').data
            .datasets[0].data;
          const month = new Date();
          month.setDate(1);
          month.setHours(0, 0, 0, 0);
          const stored = JSON.parse(localStorage.getItem('timekeeperDataPro'));
          const expectedHours = stored.entries
            .filter((entry) => new Date(entry.startTime) >= month)
            .reduce((total, entry) => total + entry.duration / 3600, 0);
          return {
            count: ids.length,
            detached: ids.filter(
              (id) => !chartApi.instances[id].canvas?.isConnected
            ).length,
            workedHours: worked.reduce((total, value) => total + value, 0),
            expectedHours
          };
        });
        if (expectedChartCount === null) expectedChartCount = chartState.count;
        expect(chartState.count).toBe(expectedChartCount);
        expect(chartState.detached).toBe(0);
        expect(chartState.workedHours).toBeCloseTo(chartState.expectedHours, 7);
        const today = await navigate(page, 'dashboard');
        samples.push(today);
        expect(today.blockingMs).toBeLessThan(750);
      }
      const entries = await navigate(page, 'entries');
      samples.push(entries);
      expect(entries.blockingMs).toBeLessThan(600);
      await expect(page.locator('#manualProjectPro option')).toHaveCount(8);
      await page.locator('#toggleEntriesViewBtn').click();
      await expect(page.locator('#entrySummaryPro')).toContainText(
        '10000 entries'
      );
      await expect(page.locator('#entriesTableBodyPro tr')).toHaveCount(100);
      await page.locator('#entrySearchInput').fill('Session 39');
      await expect(page.locator('#entrySummaryPro')).toContainText(
        '250 entries'
      );
      await page.getByRole('button', { name: 'Select Matching' }).click();
      await expect(page.locator('#entryBulkActions')).toContainText(
        '250 selected'
      );
      const saved = await page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('timekeeperDataPro'));
        return {
          count: data.entries.length,
          seconds: data.entries.reduce(
            (total, entry) => total + entry.duration,
            0
          )
        };
      });
      expect(saved).toEqual({ count: 10000, seconds: 6000000 });
      await test.info().attach('navigation-timings', {
        body: JSON.stringify(samples),
        contentType: 'application/json'
      });
    }
  );
}

test('mobile Today shortcuts invalidate after editing and undoing an entry', async ({
  page
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await seedHistory(page, 48);
  await page.goto('/#dashboard');
  const repeated = page
    .locator('.mobile-quick-timer')
    .filter({ hasText: 'Session 0' });
  await expect(repeated).toContainText('2x');
  await navigate(page, 'entries');
  const row = page
    .locator('#entriesTableBodyPro tr')
    .filter({ hasText: 'Session 0' })
    .first();
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Entry' });
  await dialog.locator('#description').fill('Adjusted session');
  await dialog.getByRole('button', { name: 'Save Entry' }).click();
  await navigate(page, 'dashboard');
  await expect(repeated).toHaveCount(0);
  await page
    .locator('#mobileUndoTray')
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expect(repeated).toContainText('2x');
});

test('mobile Today starts a timer before hidden timer controls have loaded', async ({
  page
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await seedHistory(page, 48);
  await page.goto('/#dashboard');
  await expect(page.locator('#timerProjectPro option')).toHaveCount(0);
  await page.locator('.mobile-quick-timer').first().click();
  await expect(page.locator('#timer')).toBeVisible();
  await expect(page.locator('#runningTimerPro')).toBeVisible();
  await expect(page.locator('#timerProjectPro option')).toHaveCount(8);
  await expect(page.locator('#startTimerBtnPro')).toBeEnabled();
});

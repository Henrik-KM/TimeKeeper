const { expect, test } = require('./fixtures');

async function seedHistory(page, count = 250) {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.addInitScript((entryCount) => {
    const now = Date.now();
    localStorage.setItem(
      'timekeeperDataPro',
      JSON.stringify({
        projects: [
          {
            id: 'history',
            name: 'History Project',
            budgetHours: 1000,
            hourlyRate: 100,
            startDate: '2026-01-01',
            deadline: '2027-12-31',
            createdAt: '2026-01-01T09:00:00Z'
          }
        ],
        entries: Array.from({ length: entryCount }, (_, index) => ({
          id: `history-${index}`,
          projectId: 'history',
          description: `History ${String(index).padStart(3, '0')}`,
          startTime: new Date(now - (index + 1) * 3600000).toISOString(),
          endTime: new Date(now - (index + 0.5) * 3600000).toISOString(),
          duration: 1800,
          isRunning: false
        })),
        usagePreferences: { groupEntries: false }
      })
    );
  }, count);
}

test('mobile long history loads on demand and pages without changing totals or selection', async ({
  page
}) => {
  await seedHistory(page);
  await page.goto('/');
  await expect(page.locator('#todayCommandPanel')).toBeVisible();
  await expect(page.locator('#entriesTableBodyPro tr')).toHaveCount(0);

  await page.locator('#navList li[data-section="entries"]').click();
  const rows = page.locator('#entriesTableBodyPro tr');
  const pagination = page.locator('#entryPagination');
  const summary = page.locator('#entrySummaryPro');
  await expect(rows).toHaveCount(100);
  await expect(summary).toContainText('250 entries');
  await expect(summary).toContainText('125h');
  await expect(pagination).toContainText('1–100 of 250 entries');
  await expect(rows.first()).toContainText('History 000');

  await pagination.getByRole('button', { name: 'Next' }).click();
  await expect(rows).toHaveCount(100);
  await expect(rows.first()).toContainText('History 100');
  await expect(summary).toContainText('250 entries');
  await page.getByRole('button', { name: 'Select Matching' }).click();
  await expect(page.locator('#entryBulkActions')).toContainText('250 selected');
  await expect(rows.locator('input[type="checkbox"]:checked')).toHaveCount(100);

  await pagination.getByRole('button', { name: 'Next' }).click();
  await expect(rows).toHaveCount(50);
  await expect(rows.last()).toContainText('History 249');
  await expect(pagination.getByRole('button', { name: 'Next' })).toBeDisabled();
  await expect(summary).toContainText('125h');

  await page.locator('#entrySearchInput').fill('History 249');
  await expect(rows).toHaveCount(1);
  await expect(pagination).toBeHidden();
  await expect(summary).toContainText('1 entry');
  await page.locator('#entrySearchInput').fill('');
  await expect(pagination).toContainText('1–100 of 250 entries');
  await expect(rows).toHaveCount(100);

  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    contentWidth: document.documentElement.scrollWidth
  }));
  expect(viewport.contentWidth).toBeLessThanOrEqual(viewport.width + 2);
  const entryCount = await page.evaluate(
    () => JSON.parse(localStorage.getItem('timekeeperDataPro')).entries.length
  );
  expect(entryCount).toBe(250);
});

test('mobile short history hides pagination and launch shortcuts render immediately', async ({
  page
}) => {
  await seedHistory(page, 2);
  await page.goto('/#entries');
  await expect(page.locator('#entriesTableBodyPro tr')).toHaveCount(2);
  await expect(page.locator('#entryPagination')).toBeHidden();
  await page.locator('#navList li[data-section="timer"]').click();
  await expect(page.locator('#timerProjectPro')).toContainText(
    'History Project'
  );
  await expect(page.locator('#todayCommandPanel')).toBeHidden();
});

test('mobile timer skips hidden updates and catches up on foreground return', async ({
  page
}) => {
  await page.clock.install();
  await seedHistory(page, 2);
  await page.goto('/#timer');
  await page.locator('#startTimerBtnPro').click();
  await page.clock.runFor(2000);
  const elapsed = page.locator('[id^="runningElapsed-"]');
  const beforeBackground = await elapsed.textContent();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true
    });
  });
  await page.clock.runFor(65000);
  await expect(elapsed).toHaveText(beforeBackground);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(elapsed).toContainText('1m 7s effective');
  await page.locator('#navList li[data-section="dashboard"]').click();
  await expect(page.locator('#mobileNowBar')).toContainText('1m 7s');
  await page
    .locator('#mobileNowBar')
    .getByRole('button', { name: 'Stop', exact: true })
    .click();
  const stoppedSeconds = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('timekeeperDataPro'));
    return saved.entries.at(-1).duration;
  });
  expect(stoppedSeconds).toBe(67);
});

const { expect, test } = require('./fixtures');

async function seedHistory(page, count, compressed = false) {
  const now = Date.now();
  const projects = Array.from({ length: 4 }, (_, index) => ({
    id: `p${index}`,
    name: `Project ${index}`,
    budgetHours: 100000,
    hourlyRate: 100,
    startDate: '2025-01-01',
    deadline: '2027-12-31',
    createdAt: '2025-01-01T09:00:00Z'
  }));
  const entries = Array.from({ length: count }, (_, index) => {
    const offset = ((index * 1543) % count) + 1;
    return {
      id: `history-${index}`,
      projectId: `p${index % 4}`,
      description: `Session ${index % 40}`,
      startTime: new Date(now - offset * 1800000).toISOString(),
      endTime: new Date(now - offset * 1800000 + 600000).toISOString(),
      createdAt: new Date(now - offset * 1800000).toISOString(),
      duration: 600,
      focusFactor: 1,
      manualFactor: 1,
      isRunning: false,
      retainedMetadata: { original: index }
    };
  });
  let stored = JSON.stringify({ projects, entries });
  if (compressed) {
    const { compressToUTF16 } =
      await import('../../src/shared/vendor/lz-string.mjs');
    stored = 'timekeeper-lz1:' + compressToUTF16(stored);
  }
  await page.addInitScript((raw) => {
    if (!localStorage.getItem('timekeeperDataPro')) {
      localStorage.setItem('timekeeperDataPro', raw);
    }
  }, stored);
}

async function savedSummary(page) {
  return page.evaluate(async () => {
    const modulePath = '/src/shared/profile-storage.mjs';
    const { loadStoredProfile } = await import(modulePath);
    const saved = loadStoredProfile(localStorage, 'timekeeperDataPro');
    const history = saved.entries.filter((entry) =>
      entry.id.startsWith('history-')
    );
    return {
      count: saved.entries.length,
      historyCount: history.length,
      historySeconds: history.reduce(
        (total, entry) => total + entry.duration,
        0
      ),
      metadataPreserved: history.every(
        (entry, index) => entry.retainedMetadata.original === index
      ),
      timers: saved.entries
        .filter((entry) => !entry.id.startsWith('history-'))
        .map((entry) => ({
          projectId: entry.projectId,
          running: entry.isRunning,
          focus: entry.focusFactor,
          elapsed: entry.elapsedSeconds,
          duration: entry.duration
        }))
    };
  });
}

for (const scenario of [
  { name: 'desktop', width: 1280, height: 900, compressed: false },
  { name: 'mobile', width: 412, height: 915, compressed: false },
  { name: 'mobile compressed', width: 412, height: 915, compressed: true }
]) {
  test(`${scenario.name} timer starts stay responsive with 10000 saved entries`, async ({
    page
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({
      width: scenario.width,
      height: scenario.height
    });
    await page.route('https://**', (route) => route.abort());
    await page.route('**/service-worker.js*', (route) => route.abort());
    await seedHistory(page, 10000, scenario.compressed);
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto('/#timer');
    await expect(page.locator('#startTimerBtnPro')).toBeEnabled();
    const timings = [];
    for (const [projectId, factor] of [
      ['p0', '0.5'],
      ['p1', '1']
    ]) {
      await page.locator('#timerProjectPro').selectOption(projectId);
      await page.locator('#startFactorPro').selectOption(factor);
      const timing = await page.evaluate(async () => {
        const start = performance.now();
        document.getElementById('startTimerBtnPro').click();
        const synchronousMs = performance.now() - start;
        await new Promise((resolve) => {
          requestAnimationFrame(() => window.setTimeout(resolve, 0));
        });
        return { synchronousMs, afterPaintMs: performance.now() - start };
      });
      timings.push(timing);
      expect(timing.synchronousMs).toBeLessThan(500);
      expect(timing.afterPaintMs).toBeLessThan(900);
    }
    await test.info().attach('timer-start-timings', {
      body: JSON.stringify(timings),
      contentType: 'application/json'
    });
    await expect(page.locator('[id^="runningElapsed-"]')).toHaveCount(2);
    await expect(page.locator('#entriesTableBodyPro tr')).toHaveCount(0);
    const saved = await savedSummary(page);
    expect(saved).toMatchObject({
      count: 10002,
      historyCount: 10000,
      historySeconds: 6000000,
      metadataPreserved: true,
      timers: [
        { projectId: 'p0', running: true, focus: 0.5 },
        { projectId: 'p1', running: true, focus: 1 }
      ]
    });
    await page.reload();
    await expect(page.locator('[id^="runningElapsed-"]')).toHaveCount(2);
    await page
      .getByRole('button', { name: 'Stop All Timers', exact: true })
      .click();
    await expect(page.locator('#runningTimerPro')).toBeHidden();
    expect(await savedSummary(page)).toMatchObject({
      count: 10002,
      historyCount: 10000,
      historySeconds: 6000000,
      metadataPreserved: true,
      timers: [
        { projectId: 'p0', running: false, focus: 0.5 },
        { projectId: 'p1', running: false, focus: 1 }
      ]
    });
    if (scenario.width < 600) {
      const dimensions = await page.evaluate(() => ({
        width: window.innerWidth,
        content: document.documentElement.scrollWidth
      }));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 2);
      await page.screenshot({
        path: test.info().outputPath('mobile-timer.png')
      });
    }
  });
}

test('mobile failed timer start preserves the running timer and its elapsed time', async ({
  page
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.clock.install({ time: new Date('2026-11-13T12:00:00') });
  await seedHistory(page, 2);
  await page.goto('/#timer');
  await page.locator('#timerProjectPro').selectOption('p0');
  await page.locator('#startFactorPro').selectOption('0.5');
  await page.locator('#startTimerBtnPro').click();
  await page.clock.runFor(5000);
  await page.locator('#timerProjectPro').selectOption('p1');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('timekeeperDataPro')) {
        throw new DOMException('Full', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
    document.getElementById('startTimerBtnPro').addEventListener(
      'click',
      () => {
        Storage.prototype.setItem = original;
      },
      { once: true }
    );
  });
  await page.locator('#startTimerBtnPro').click();
  await expect(page.locator('.app-toast').last()).toContainText(
    'browser storage is full'
  );
  await expect(page.locator('[id^="runningElapsed-"]')).toHaveCount(1);
  await page.clock.runFor(5000);
  await expect(page.locator('[id^="runningElapsed-"]')).toContainText(
    '5s effective'
  );
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const saved = await savedSummary(page);
  expect(saved.count).toBe(3);
  expect(saved.timers).toEqual([
    { projectId: 'p0', running: false, focus: 0.5, elapsed: 10, duration: 5 }
  ]);
});

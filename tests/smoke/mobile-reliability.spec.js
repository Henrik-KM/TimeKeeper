const { test, expect } = require('./fixtures');
const { createServer } = require('node:http');
const { once } = require('node:events');

test.use({
  viewport: { width: 393, height: 851 },
  isMobile: true,
  hasTouch: true
});

const project = {
  id: 'field',
  name: 'Field notes',
  budgetHours: 20,
  hourlyRate: 0,
  startDate: '2026-01-01',
  deadline: '2027-12-31'
};

async function seed(page, entries = []) {
  await page.addInitScript(
    (profile) => {
      if (!localStorage.getItem('timekeeperDataPro')) {
        localStorage.setItem('timekeeperDataPro', JSON.stringify(profile));
      }
    },
    { projects: [project], entries }
  );
}

function profile(page) {
  return page.evaluate(async () => {
    const path = '/src/shared/profile-storage.mjs';
    const { loadStoredProfile } = await import(path);
    return loadStoredProfile(localStorage, 'timekeeperDataPro');
  });
}

async function preparePurchase(page) {
  await page.goto('/#grocery');
  await page.locator('#financeQuickPurchaseMobileButton').click();
  const sheet = page.getByRole('dialog', { name: 'Quick purchase' });
  await sheet.getByPlaceholder('Purchase name').fill('Bus ticket');
  await sheet.getByPlaceholder('Cost (SEK)').fill('38');
  return sheet;
}

for (const useWebLocks of [true, false]) {
  test(`mobile two open tabs retain a running timer and a separate purchase (${useWebLocks ? 'Web Locks' : 'IndexedDB'})`, async ({
    page,
    context
  }) => {
    if (!useWebLocks)
      await context.addInitScript(() =>
        Object.defineProperty(navigator, 'locks', { value: undefined })
      );
    await seed(page);
    await page.goto('/#timer');
    const other = await context.newPage();
    const sheet = await preparePurchase(other);
    await page.locator('#startTimerBtnPro').click();
    await expect.poll(async () => (await profile(page)).entries.length).toBe(1);
    const timerRevision = (await profile(page)).backupRevision;
    await sheet.getByRole('button', { name: 'Log purchase' }).click();
    await expect
      .poll(async () =>
        (await profile(other)).groceries.some((p) => p.name === 'Bus ticket')
      )
      .toBe(true);
    await page.reload();
    const saved = await profile(page);
    expect(saved.backupRevision).toBeGreaterThan(timerRevision);
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0]).toMatchObject({
      projectId: 'field',
      isRunning: true
    });
    expect(saved.groceries.filter((p) => p.name === 'Bus ticket')).toHaveLength(
      1
    );
    await expect(page.locator('#runningTimerPro')).toBeVisible();
  });
}

test('mobile concurrent edits survive both tabs closing before a compressed profile can be written', async ({
  page,
  context
}) => {
  const { compressToUTF16 } =
    await import('../../src/shared/vendor/lz-string.mjs');
  const raw =
    'timekeeper-lz1:' +
    compressToUTF16(
      JSON.stringify({
        projects: [project],
        entries: [],
        retained: { flag: true }
      })
    );
  // Hold the real writer lock to force both forms to submit before either edit
  // can reach the canonical profile, then discard both documents.
  await page.route('**/writer-guard.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Writer guard</title>'
    })
  );
  await page.goto('/writer-guard.html');
  await page.evaluate(async (stored) => {
    localStorage.setItem('timekeeperDataPro', stored);
    await new Promise((ready) => {
      navigator.locks.request('timekeeperDataPro', async () => {
        ready(undefined);
        await new Promise(() => {});
      });
    });
  }, raw);
  const timer = await context.newPage();
  const purchases = await context.newPage();
  await timer.goto('/#timer');
  const sheet = await preparePurchase(purchases);
  await Promise.all([
    timer.locator('#startTimerBtnPro').click(),
    sheet.getByRole('button', { name: 'Log purchase' }).click()
  ]);
  await expect(timer.locator('#runningTimerPro')).toBeVisible();
  await expect(sheet).toBeHidden();
  expect((await profile(page)).entries).toHaveLength(0);
  await Promise.all([timer.close(), purchases.close()]);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/#timer');
  await expect(reopened.locator('#runningTimerPro')).toBeVisible();
  const saved = await profile(reopened);
  expect(saved.entries).toHaveLength(1);
  expect(
    saved.groceries.filter((item) => item.name === 'Bus ticket')
  ).toHaveLength(1);
  expect(saved.retained).toEqual({ flag: true });
  expect(
    await reopened.evaluate(() =>
      Object.keys(localStorage).filter(
        (key) =>
          key.startsWith('timekeeperDataPro:pending:') ||
          key.startsWith('timekeeperDataPro:conflict:')
      )
    )
  ).toEqual([]);
});

test('mobile stale start for the same project keeps the original timer', async ({
  page,
  context
}) => {
  await seed(page);
  await page.goto('/#timer');
  const other = await context.newPage();
  await other.goto('/#timer');
  await other.locator('#timerDescriptionPro').fill('Later start');
  await page.locator('#startTimerBtnPro').click();
  const [{ id }] = (await profile(page)).entries;
  // Keep the unsaved field focused while submitting the stale form.
  await other.evaluate(() =>
    document.getElementById('startTimerBtnPro').click()
  );
  await expect(
    other.getByText(
      'A timer for this project was already started in another tab.'
    )
  ).toBeVisible();
  expect((await profile(other)).entries.map((entry) => entry.id)).toEqual([id]);
});

test('mobile undo opened before another tab saves cannot overwrite its timer', async ({
  page,
  context
}) => {
  await seed(page);
  const sheet = await preparePurchase(page);
  await sheet.getByRole('button', { name: 'Log purchase' }).click();
  await page
    .locator('#mobileUndoTray')
    .getByRole('button', { name: 'History' })
    .click();
  const history = page.getByRole('dialog', { name: 'Recent actions' });
  const timer = await context.newPage();
  await timer.goto('/#timer');
  await timer.locator('#startTimerBtnPro').click();
  await expect.poll(async () => (await profile(timer)).entries.length).toBe(1);
  await history
    .getByRole('button', { name: 'Undo', exact: true })
    .first()
    .click();
  await expect(
    page.getByText('Another tab changed this profile. This undo has expired.')
  ).toBeVisible();
  const saved = await profile(page);
  expect(saved.entries[0].isRunning).toBe(true);
  expect(
    saved.groceries.filter((item) => item.name === 'Bus ticket')
  ).toHaveLength(1);
});

test('mobile reopening offers an interrupted conflicting edit for download', async ({
  page
}) => {
  const request = {
    changes: [
      {
        path: ['projects', { id: project.id }, 'name'],
        before: 'Old name',
        after: 'Proposed name'
      }
    ],
    baseRevision: 1,
    revision: 2,
    bump: true,
    updatedAt: '2026-01-01T12:00:00Z'
  };
  await page.addInitScript(
    ({ project, request }) => {
      localStorage.setItem(
        'timekeeperDataPro',
        JSON.stringify({ projects: [project], entries: [], backupRevision: 2 })
      );
      localStorage.setItem(
        'timekeeperDataPro:pending:prior-edit',
        JSON.stringify(request)
      );
    },
    { project, request }
  );
  await page.goto('/#timer');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download and clear copy' }).click();
  const copy = await download;
  const { readFile } = require('node:fs/promises');
  expect(JSON.parse(await readFile(await copy.path(), 'utf8'))).toEqual([
    request
  ]);
  expect((await profile(page)).projects[0].name).toBe(project.name);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).some((key) =>
        key.startsWith('timekeeperDataPro:conflict:')
      )
    )
  ).toBe(false);
});

test('mobile logging a new named workout saves the session, preset and points', async ({
  page
}) => {
  await page.route('**/assets/strava.json*', (route) =>
    route.fulfill({ json: { activities: [] } })
  );
  await page.goto('/#today');
  await page.getByRole('button', { name: /Daily workout target/i }).click();
  const sheet = page.getByRole('dialog', { name: 'Log workout', exact: true });
  await sheet.getByPlaceholder('Workout name').fill('Evening walk');
  await sheet.getByRole('button', { name: 'Log workout', exact: true }).click();
  await expect(sheet).toBeHidden();
  await page.reload();
  const { workouts } = await profile(page);
  expect(workouts.entries).toHaveLength(1);
  expect(workouts.presets).toHaveLength(1);
  expect(workouts.entries[0]).toMatchObject({
    name: 'Evening walk',
    intensity: 'medium',
    presetId: workouts.presets[0].id
  });
  await page.goto('/#workouts');
  await expect(page.locator('#workoutEntriesContent')).toContainText(
    'Evening walk'
  );
  await expect(page.locator('#workoutEntriesContent')).toContainText('4 pts');
});

test('mobile JSON restore retains a paused timer’s credited time when stopped', async ({
  page,
  browser,
  baseURL
}) => {
  await seed(page);
  await page.goto('/#timer');
  await page.locator('#timerInitialPro').fill('0.5');
  await page.locator('#startTimerBtnPro').click();
  await page.locator('#navList [data-section="dashboard"]').click();
  await page.locator('#mobileNowBar .mobile-now-summary').click();
  await page
    .getByRole('dialog', { name: 'Running timer' })
    .getByRole('button', { name: 'Pause', exact: true })
    .click();
  await page.goto('/#sync');
  const download = page.waitForEvent('download');
  await page.locator('#exportBtnPro').click();
  const file = await (await download).path();
  const restored = await browser.newContext({
    baseURL,
    viewport: { width: 393, height: 851 },
    serviceWorkers: 'block'
  });
  try {
    await restored.route('http://127.0.0.1:8766/**', (route) => route.abort());
    const copy = await restored.newPage();
    await copy.goto('/#sync');
    await copy.locator('#importInputPro').setInputFiles(file);
    await expect.poll(async () => (await profile(copy)).entries.length).toBe(1);
    const original = (await profile(page)).entries[0];
    expect(original.effectiveSeconds).toBeGreaterThanOrEqual(1800);
    expect((await profile(copy)).entries[0]).toMatchObject({
      effectiveSeconds: original.effectiveSeconds,
      pausedAt: original.pausedAt,
      lastUpdateTime: original.lastUpdateTime
    });
    await copy.locator('#navList [data-section="dashboard"]').click();
    await copy
      .locator('#mobileNowBar')
      .getByRole('button', { name: 'Stop', exact: true })
      .click();
    expect((await profile(copy)).entries[0].duration).toBe(
      Math.floor(original.effectiveSeconds)
    );
  } finally {
    await restored.close();
  }
});

test('mobile recent entry appears directly below Quick log before filters', async ({
  page
}) => {
  const end = new Date();
  await seed(page, [
    {
      id: 'e',
      projectId: 'field',
      description: 'Notebook review',
      startTime: new Date(end.getTime() - 1800000).toISOString(),
      endTime: end.toISOString(),
      duration: 1800,
      isRunning: false
    }
  ]);
  await page.goto('/#entries');
  await expect(page.locator('#entriesTableBodyPro tr').first()).toContainText(
    'Notebook review'
  );
  const bounds = () =>
    page.evaluate(() => {
      const pos = (selector) =>
        document.querySelector(selector).getBoundingClientRect();
      return {
        first: pos('#entriesTableBodyPro tr').top,
        quickEnd: pos('#quickLogForm').bottom,
        dock: pos('.sidebar').top,
        filter: pos('#entrySearchInput').top
      };
    });
  const phone = await bounds();
  expect(phone.first - phone.quickEnd).toBeGreaterThanOrEqual(0);
  expect(phone.first - phone.quickEnd).toBeLessThan(48);
  expect(phone.first).toBeLessThan(phone.dock);
  await page.screenshot({
    path: test.info().outputPath('android-entries.png')
  });
  await page.locator('#entryFiltersJump').click();
  await expect(page.locator('#entryProjectFilter')).toBeFocused();
  await page.locator('#entrySearchInput').fill('Notebook');
  await page.locator('#entryResultsJump').click();
  await expect(
    page.getByRole('region', { name: 'Time entries' })
  ).toBeFocused();
  for (const width of [360, 412]) {
    await page.setViewportSize({ width, height: 851 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const box = await bounds();
    expect(box.first - box.quickEnd).toBeLessThan(48);
    expect(box.first).toBeLessThan(box.dock);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(width);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect
    .poll(async () => {
      const box = await bounds();
      return box.filter < box.first;
    })
    .toBe(true);
  await expect(page.locator('#entryFiltersJump')).toBeHidden();
  await expect(page.locator('#entryResultsJump')).toBeHidden();
});

test.describe('mobile offline startup', () => {
  test.use({ serviceWorkers: 'allow' });
  test('first offline reopening boots after a single online visit', async ({
    page,
    context,
    baseURL
  }) => {
    // A separate origin can actually be disconnected, including requests from the worker.
    const origin = createServer(async (req, res) => {
      try {
        const response = await fetch(new URL(req.url, baseURL));
        res.writeHead(response.status, {
          'content-type': response.headers.get('content-type'),
          'cache-control': 'no-store'
        });
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.destroy();
      }
    });
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    const address = origin.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected a local TCP address');
    const url = 'http://127.0.0.1:' + address.port + '/';
    try {
      await page.goto(url);
      await expect(
        page.locator('#todayCommandPanel .mobile-today-card').first()
      ).toBeVisible();
      await page.waitForFunction(
        () => navigator.serviceWorker.controller?.state === 'activated'
      );
      await page.close();
      const closed = once(origin, 'close');
      origin.close();
      origin.closeAllConnections();
      await closed;
      await context.setOffline(true);
      const offline = await context.newPage();
      await offline.goto(url + 'index.html#today', {
        waitUntil: 'domcontentloaded'
      });
      await expect(
        offline.locator('#todayCommandPanel .mobile-today-card').first()
      ).toBeVisible();
      await offline.locator('#navList [data-section="timer"]').click();
      await expect(offline.locator('#timerEmptyState')).toBeVisible();
    } finally {
      if (origin.listening) {
        origin.close();
        origin.closeAllConnections();
      }
    }
  });
});

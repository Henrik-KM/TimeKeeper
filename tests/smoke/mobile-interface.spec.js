const { test, expect } = require('@playwright/test');

test('mobile release bypasses an older cached root stylesheet', async ({
  page
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.route(/\/style\.css$/, (route) =>
    route.fulfill({
      contentType: 'text/css',
      body: 'body { background: pink; }'
    })
  );
  await page.goto('/#dashboard');
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--mobile-dock-height')
          .trim()
      )
    )
    .toBe('76px');
  await expect(
    page.locator('#navList [data-section="dashboard"]')
  ).toBeVisible();
});

async function seedWorkspace(page) {
  await page.addInitScript(() => {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
    localStorage.setItem(
      'timekeeperDataPro',
      JSON.stringify({
        projects: [
          {
            id: 'mobile-design',
            name: 'Research and development',
            client: 'Studio',
            budgetHours: 400,
            hourlyRate: 100,
            startDate: '2026-01-01',
            deadline: '2027-12-31',
            createdAt: start,
            roundingMinutes: 0
          }
        ],
        entries: [
          {
            id: 'mobile-running',
            projectId: 'mobile-design',
            description: 'Design review',
            startTime: start,
            endTime: null,
            duration: null,
            isRunning: true,
            createdAt: start,
            lastUpdateTime: now.toISOString(),
            effectiveSeconds: 1800,
            factor: 1,
            focusFactor: 1,
            manualFactor: 1
          }
        ]
      })
    );
  });
}

test.describe('mobile portrait startup and rotation', () => {
  test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  for (const width of [360, 412]) {
    test(`Today keeps its initial text and card sizes after rotation at ${width}px`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 915 });
      await seedWorkspace(page);
      await page.goto('/#dashboard');
      const panel = page.locator('#todayCommandPanel');
      await expect(panel).toHaveClass(/mobile-today-panel/);
      await expect(page.locator('.mobile-today-card')).toHaveCount(4);
      const measureCards = () =>
        page.locator('.mobile-today-card').evaluateAll((cards) =>
          cards.map((card) => ({
            width: card.getBoundingClientRect().width,
            height: card.getBoundingClientRect().height,
            fontSize: getComputedStyle(card.querySelector('strong')).fontSize
          }))
        );
      const initial = await measureCards();
      const primaryBounds = await page
        .locator('.mobile-today-primary')
        .boundingBox();
      expect(primaryBounds.height).toBeLessThanOrEqual(200);
      for (const card of initial) {
        expect(card.height).toBeGreaterThanOrEqual(48);
      }
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue(
            'text-size-adjust'
          )
        )
      ).toBe('100%');
      await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute(
        'content',
        /user-scalable\s*=\s*no|maximum-scale/
      );

      await page.setViewportSize({ width: 915, height: width });
      await expect(panel).not.toHaveClass(/mobile-today-panel/);
      await page.setViewportSize({ width, height: 915 });
      await expect(panel).toHaveClass(/mobile-today-panel/);
      await expect.poll(measureCards).toEqual(initial);
      await page
        .getByRole('button', {
          name: 'Running now Research and development',
          exact: true
        })
        .click();
      await expect(page.locator('#timer')).toBeVisible();
    });
  }
});

for (const width of [360, 412, 480]) {
  test(`mobile interface fits every section at ${width}px`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width, height: 915 });
    await seedWorkspace(page);
    await page.goto('/#dashboard');
    const primary = ['dashboard', 'timer', 'company', 'entries'];
    const sections = [
      ['dashboard', 'Today'],
      ['timer', 'Timer'],
      ['company', 'Company'],
      ['entries', 'Entries'],
      ['projects', 'Projects'],
      ['todo', 'Workouts'],
      ['grocery', 'Finances'],
      ['analytics', 'Reports'],
      ['codex', 'Codex'],
      ['importExport', 'Backup / Sync']
    ];
    for (const [id, label] of sections) {
      if (primary.includes(id)) {
        await page.locator(`#navList [data-section="${id}"]`).click();
      } else {
        await page.locator('.mobile-more-nav-item').click();
        await page
          .getByRole('dialog', { name: 'More', exact: true })
          .getByRole('button', { name: label, exact: true })
          .click();
      }
      await expect(page.locator(`#${id}`)).toBeVisible();
      const metrics = await page.evaluate(() => ({
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        nav: Array.from(document.querySelectorAll('#navList li'))
          .filter((el) => el.getBoundingClientRect().height > 0)
          .map((el) => ({
            width: el.getBoundingClientRect().width,
            height: el.getBoundingClientRect().height
          }))
      }));
      expect(
        metrics.scrollWidth,
        `${id} horizontal overflow`
      ).toBeLessThanOrEqual(metrics.width + 1);
      for (const target of metrics.nav) {
        expect(target.height).toBeGreaterThanOrEqual(48);
        expect(target.width).toBeGreaterThanOrEqual(48);
      }
      if (width === 412) {
        await page.screenshot({ path: testInfo.outputPath(`${id}.png`) });
      }
    }
  });
}

test('mobile More restores focus and timer controls stay clear of the dock', async ({
  page
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await seedWorkspace(page);
  await page.goto('/#dashboard');
  const more = page.locator('.mobile-more-nav-item');
  await more.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'More', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(more).toBeFocused();
  const bar = page.locator('#mobileNowBar');
  await expect(bar).toBeVisible();
  const barBounds = await bar.boundingBox();
  const navBounds = await page.locator('.sidebar').boundingBox();
  expect(barBounds.y + barBounds.height).toBeLessThanOrEqual(navBounds.y);
  await bar.locator('.mobile-now-summary').click();
  const timerDialog = page.getByRole('dialog', {
    name: 'Running timer',
    exact: true
  });
  await expect(timerDialog).toBeVisible();
  await page.setViewportSize({ width: 412, height: 460 });
  const save = timerDialog.getByRole('button', { name: 'Save changes' });
  const saveBounds = await save.boundingBox();
  expect(saveBounds.y + saveBounds.height).toBeLessThanOrEqual(460);
  await timerDialog.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(timerDialog).toBeHidden();
  await expect(bar).toContainText('paused');
  await bar.locator('.mobile-now-summary').click();
  await timerDialog
    .getByRole('button', { name: 'Resume', exact: true })
    .click();
  await expect(bar).not.toContainText('paused');
});

test('mobile Projects puts existing work before the optional creation form', async ({
  page
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await seedWorkspace(page);
  await page.goto('/#projects');
  await expect(page.locator('#projectsPageList')).toContainText(
    'Research and development'
  );
  await expect(page.locator('#projectFormPro')).toBeHidden();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.locator('#projectFormPro')).toBeVisible();
  await page.locator('#projectNamePro').fill('Unfinished project');
  await page
    .getByRole('button', { name: 'Hide project form', exact: true })
    .click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.locator('#projectNamePro')).toHaveValue(
    'Unfinished project'
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.locator('#projectFormPro')).toBeVisible();
  await expect(page.locator('.mobile-more-nav-item')).toBeHidden();
  for (const section of ['projects', 'codex', 'importExport']) {
    await page.goto('/#' + section);
    await expect(page.locator('#' + section)).toBeVisible();
  }
});

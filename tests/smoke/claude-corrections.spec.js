const { expect, test } = require('@playwright/test');

for (const width of [390, 1280]) {
  test(`Claude history corrections survive reload and stale feeds at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const now = new Date();
    const start = new Date(now.getTime() - 2 * 3600000).toISOString();
    const end = new Date(now.getTime() - 3600000).toISOString();
    const oldStart = new Date(now.getTime() - 60 * 86400000).toISOString();
    const oldEnd = new Date(
      now.getTime() - 60 * 86400000 + 3600000
    ).toISOString();
    const record = {
      id: 'claude:11111111111111111111111111111111',
      sessionId: '11111111-2222-4333-8444-555555555555',
      timekeeperProjectId: 'anders',
      repoName: 'example',
      startTime: start,
      endTime: end,
      wallSeconds: 3600,
      effectiveSeconds: 1800,
      delegatedSessionCount: 0,
      focusPolicyVersion: 1,
      modelBreakdown: [
        {
          role: 'parent',
          model: 'opus',
          factor: 0.5,
          creditMultiplier: 1,
          creditedFactor: 0.5,
          wallSeconds: 3600,
          effectiveSeconds: 1800
        }
      ]
    };
    const corrected = {
      ...record,
      focusPolicyVersion: 3,
      wallSeconds: 600,
      effectiveSeconds: 300,
      repairOnly: true
    };
    const historical = {
      ...corrected,
      id: 'claude:22222222222222222222222222222222',
      startTime: oldStart,
      endTime: oldEnd
    };
    const zeroId = 'claude:33333333333333333333333333333333';
    const asEntry = (raw, id) => ({
      id,
      projectId: 'anders',
      description: 'Claude: example',
      source: 'claude',
      externalId: raw.id,
      startTime: raw.startTime,
      endTime: raw.endTime,
      duration: 1800,
      elapsedSeconds: 3600,
      isRunning: false,
      focusFactor: 0.5,
      manualFactor: 0.5,
      claudeFocusPolicyVersion: 1,
      notes: 'Preserve this user field'
    });
    await page.addInitScript(
      (payload) => {
        if (!localStorage.getItem('timekeeperDataPro')) {
          localStorage.setItem('timekeeperDataPro', JSON.stringify(payload));
        }
      },
      {
        projects: [
          {
            id: 'anders',
            name: 'Anders',
            budgetHours: 100,
            hourlyRate: 100,
            startDate: oldStart.slice(0, 10),
            color: '#2563eb'
          }
        ],
        entries: [
          asEntry(record, 'keep-current-id'),
          asEntry(historical, 'keep-historical-id'),
          asEntry({ ...record, id: zeroId }, 'remove-passive-only'),
          { ...asEntry(record, 'keep-manual'), source: 'manual' }
        ],
        codexIntegration: { enabled: false },
        claudeIntegration: { enabled: true }
      }
    );
    let repairAvailable = true;
    await page.route('https://api.github.com/**', async (route) => {
      const directory =
        '/repos/Henrik-KM/TimeKeeper/contents/assets/timekeeper-claude-inbox';
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === directory) {
        const names = repairAvailable
          ? ['repair.json', 'legacy.json']
          : ['legacy.json'];
        await route.fulfill({
          json: names.map((name) => ({
            type: 'file',
            name,
            url: `https://api.github.com${directory}/${name}`
          }))
        });
      } else if (pathname === `${directory}/repair.json`) {
        await route.fulfill({
          json: {
            source: 'timekeeper-claude-bridge',
            focusPolicyVersion: 3,
            updatedAt: now.toISOString(),
            records: [
              corrected,
              historical,
              { ...historical, id: 'claude:44444444444444444444444444444444' }
            ],
            retractedExternalIds: [zeroId]
          }
        });
      } else if (pathname === `${directory}/legacy.json`) {
        await route.fulfill({
          json: {
            source: 'timekeeper-claude-bridge',
            updatedAt: new Date(now.getTime() + 60000).toISOString(),
            records: [record, { ...record, id: zeroId }]
          }
        });
      } else {
        await route.fulfill({ status: 404, json: {} });
      }
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/#entries');
    const read = () =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('timekeeperDataPro'))
      );
    await expect.poll(async () => (await read()).entries.length).toBe(3);
    let data = await read();
    for (const id of ['keep-current-id', 'keep-historical-id']) {
      expect(data.entries.find((entry) => entry.id === id)).toMatchObject({
        duration: 300,
        elapsedSeconds: 600,
        claudeFocusPolicyVersion: 3,
        notes: 'Preserve this user field'
      });
    }
    expect(
      data.entries.find((entry) => entry.id === 'keep-manual').duration
    ).toBe(1800);
    expect(data.claudeIntegration.retractedRecordIds).toEqual([zeroId]);
    expect(data.claudeReconciliationHistory[0].removed[0]).toMatchObject({
      id: 'remove-passive-only',
      notes: 'Preserve this user field'
    });
    await expect(page.locator('#entriesTableBodyPro')).toContainText(
      '10m 0s active'
    );
    repairAvailable = false;
    await page.reload();
    await expect
      .poll(
        async () =>
          (await read()).claudeReconciliationHistory[0].removed[0].notes
      )
      .toBe('Preserve this user field');
    await page.goto('/#importExport');
    await page
      .getByRole('button', { name: 'Import Claude', exact: true })
      .click();
    data = await read();
    expect(data.entries).toHaveLength(3);
    expect(
      data.entries.find((entry) => entry.id === 'keep-current-id').duration
    ).toBe(300);
    expect(errors).toEqual([]);
    expect(
      await page
        .locator('body')
        .evaluate((body) => body.scrollWidth <= innerWidth + 1)
    ).toBe(true);
  });
}

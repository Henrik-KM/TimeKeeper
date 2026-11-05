const { expect, test } = require('@playwright/test');

for (const width of [390, 1280]) {
  test(`Codex corrections survive reload, expired feeds and stale replay at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const now = Date.now();
    const start = new Date(now - 2 * 3600000).toISOString();
    const end = new Date(now - 3600000).toISOString();
    const historicalStart = new Date(now - 60 * 86400000).toISOString();
    const historicalEnd = new Date(now - 60 * 86400000 + 3600000).toISOString();
    /** @returns {Record<string, any>} */
    const entry = (id, externalId, overrides = {}) => ({
      id,
      externalId,
      projectId: 'work',
      source: 'codex',
      description: 'Codex: work',
      startTime: start,
      endTime: end,
      duration: 1800,
      elapsedSeconds: 3600,
      focusFactor: 0.5,
      manualFactor: 0.5,
      codexFocusPolicyVersion: 7,
      codexModelBreakdown: [
        {
          role: 'parent',
          model: 'gpt-6.1-sol',
          effort: 'max',
          fastMode: false,
          factor: 0.5,
          creditMultiplier: 1,
          wallSeconds: 3600,
          effectiveSeconds: 1800
        }
      ],
      isRunning: false,
      ...overrides
    });
    const historical = entry('historical-old', 'codex-historical-alias', {
      startTime: historicalStart,
      endTime: historicalEnd,
      notes: 'Recover this full user field',
      custom: { unknown: 'preserve' }
    });
    const profile = {
      projects: [
        {
          id: 'work',
          name: 'Work',
          budgetHours: 200,
          startDate: '2026-01-01',
          deadline: '2027-01-01'
        }
      ],
      entries: [
        entry('keeper', 'codex-aggregate', {
          codexSupersedesExternalIds: ['codex-old-parent']
        }),
        entry('duplicate', 'codex-aggregate', { notes: 'Duplicate recovery' }),
        entry('old-parent', 'codex-old-parent'),
        historical,
        entry('historical-keeper', 'codex-historical-aggregate', {
          startTime: historicalStart,
          endTime: historicalEnd
        }),
        entry('separate-session', 'codex-separate-session', {
          codexThreadId: 'independent-session'
        }),
        entry('manual', undefined, { source: 'manual' })
      ],
      codexIntegration: {
        enabled: true,
        contextSyncEnabled: false,
        repository: 'Henrik-KM/TimeKeeper',
        branch: 'main',
        inboxPath: 'assets/timekeeper-codex-inbox'
      }
    };
    const asRecord = (row, overrides = {}) => ({
      id: row.externalId,
      threadId: row.id,
      timekeeperProjectId: 'work',
      startTime: row.startTime,
      endTime: row.endTime,
      wallSeconds: 3600,
      effectiveSeconds: 1800,
      focusFactor: 0.5,
      focusPolicyVersion: 7,
      codexBackfill: true,
      ...overrides
    });
    let payloads = [
      {
        source: 'timekeeper-codex-bridge',
        updatedAt: new Date(now).toISOString(),
        records: [],
        entryCorrections: [
          {
            entryId: historical.id,
            replacementEntryId: 'historical-keeper',
            projectId: 'work',
            startTime: historicalStart,
            endTime: historicalEnd,
            effectiveSeconds: 1800,
            reason: 'superseded'
          }
        ]
      },
      {
        source: 'timekeeper-codex-bridge',
        updatedAt: new Date(now - 86400000).toISOString(),
        records: [asRecord(profile.entries[2]), asRecord(historical)]
      }
    ];
    await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
    await page.route('https://api.github.com/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/contents/assets/timekeeper-codex-inbox?')) {
        return route.fulfill({
          json: payloads.map((_, index) => ({
            type: 'file',
            name: `feed-${index}.json`,
            url: `https://api.github.com/codex-test-feed/${index}`
          }))
        });
      }
      const match = url.match(/\/codex-test-feed\/(\d+)/);
      if (match) return route.fulfill({ json: payloads[Number(match[1])] });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.addInitScript((data) => {
      if (!localStorage.getItem('timekeeperDataPro')) {
        localStorage.setItem('timekeeperDataPro', JSON.stringify(data));
      }
    }, profile);
    const read = () =>
      page.evaluate(async () => {
        const moduleUrl = new URL(
          '/src/shared/profile-storage.mjs',
          location.href
        ).href;
        const { loadStoredProfile } = await import(moduleUrl);
        return loadStoredProfile(localStorage, 'timekeeperDataPro');
      });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await expect.poll(async () => (await read()).entries.length).toBe(4);
    let saved = await read();
    expect(saved.entries.map((row) => row.id).sort()).toEqual(
      ['keeper', 'historical-keeper', 'separate-session', 'manual'].sort()
    );
    const removed = saved.codexReconciliationHistory.flatMap(
      (item) => item.removed
    );
    expect(removed).toHaveLength(3);
    expect(
      removed.find((item) => item.entry.id === historical.id).entry
    ).toMatchObject({
      notes: historical.notes,
      custom: historical.custom
    });
    expect(saved.codexIntegration.retractedCodexRecordIds).toEqual(
      expect.arrayContaining(['codex-old-parent', 'codex-historical-alias'])
    );
    expect(saved.codexIntegration.retractedCodexRecordIds).not.toContain(
      'codex-aggregate'
    );

    const keeper = saved.entries.find((row) => row.id === 'keeper');
    const changedEnd = new Date(now - 1800000).toISOString();
    payloads = [
      {
        source: 'timekeeper-codex-bridge',
        updatedAt: new Date(now + 1000).toISOString(),
        records: [
          asRecord(keeper, {
            endTime: changedEnd,
            wallSeconds: 5400,
            effectiveSeconds: 2700,
            supersedesExternalIds: ['codex-old-parent']
          })
        ]
      },
      {
        source: 'timekeeper-codex-bridge',
        updatedAt: new Date(now - 86400000).toISOString(),
        records: [asRecord(keeper)]
      }
    ];
    await page.reload();
    await expect
      .poll(
        async () =>
          (await read()).entries.find((row) => row.id === 'keeper').endTime
      )
      .toBe(changedEnd);

    // The correction feed expires; stale records cannot resurrect or roll back.
    payloads = [
      {
        source: 'timekeeper-codex-bridge',
        updatedAt: new Date(now - 86400000).toISOString(),
        records: [
          asRecord(profile.entries[2]),
          asRecord(historical),
          asRecord(keeper)
        ]
      }
    ];
    await page.reload();
    await expect
      .poll(
        async () => (await read()).codexIntegration.lastImportSummary.skipped
      )
      .toBe(3);
    saved = await read();
    expect(saved.entries).toHaveLength(4);
    expect(saved.entries.find((row) => row.id === 'keeper')).toMatchObject({
      endTime: changedEnd,
      duration: 2700,
      elapsedSeconds: 5400
    });
    expect(
      saved.codexReconciliationHistory.flatMap((item) => item.removed)
    ).toHaveLength(3);
    expect(errors).toEqual([]);
  });
}

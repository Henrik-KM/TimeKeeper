const { expect, test } = require('./fixtures');

for (const width of [390, 1280]) {
  test(`Codex activity repairs preserve notes and reject outdated producers at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const now = Date.now();
    const start = new Date(now - 60 * 86400000).toISOString();
    const end = new Date(now - 60 * 86400000 + 3600000).toISOString();
    const record = {
      id: 'codex-idle-repair',
      threadId: 'thread-idle-repair',
      timekeeperProjectId: 'anders',
      startTime: start,
      endTime: end,
      wallSeconds: 3600,
      effectiveSeconds: 1800,
      focusFactor: 0.5,
      focusPolicyVersion: 7
    };
    const entry = {
      id: 'keep-authored-id',
      projectId: 'anders',
      source: 'codex',
      externalId: record.id,
      startTime: start,
      endTime: end,
      duration: 1800,
      elapsedSeconds: 3600,
      focusFactor: 0.5,
      manualFactor: 0.5,
      codexFocusPolicyVersion: 7,
      notes: 'User note',
      custom: { preserve: true },
      isRunning: false
    };
    await page.addInitScript(
      (profile) => {
        if (!localStorage.getItem('timekeeperDataPro'))
          localStorage.setItem('timekeeperDataPro', JSON.stringify(profile));
      },
      {
        projects: [
          {
            id: 'anders',
            name: 'Anders',
            budgetHours: 100,
            startDate: '2026-01-01'
          }
        ],
        entries: [
          entry,
          { ...entry, id: 'retire-zero-work', externalId: 'codex-zero-work' },
          { ...entry, id: 'manual', source: 'manual' }
        ],
        codexIntegration: { enabled: true, contextSyncEnabled: false },
        claudeIntegration: { enabled: false }
      }
    );
    const repair = {
      ...record,
      activityPolicyVersion: 1,
      wallSeconds: 1200,
      effectiveSeconds: 600,
      repairOnly: true
    };
    let withRepair = true;
    let resumed = false;
    await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
    await page.route('https://api.github.com/**', async (route) => {
      const directory =
        '/repos/Henrik-KM/TimeKeeper/contents/assets/timekeeper-codex-inbox';
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === directory)
        return route.fulfill({
          json: (withRepair ? ['repair', 'stale'] : ['stale']).map((name) => ({
            type: 'file',
            name: `${name}.json`,
            url: `https://api.github.com${directory}/${name}.json`
          }))
        });
      if (pathname === `${directory}/repair.json`)
        return route.fulfill({
          json: {
            source: 'timekeeper-codex-bridge',
            updatedAt: new Date(now - 60000).toISOString(),
            retractedExternalIds: ['codex-zero-work'],
            records: [
              resumed
                ? {
                    ...repair,
                    id: 'codex-resumed-id',
                    wallSeconds: 1400,
                    effectiveSeconds: 700
                  }
                : repair,
              {
                ...repair,
                id: 'codex-missing-repair',
                startTime: new Date(now - 7200000).toISOString(),
                endTime: new Date(now - 3600000).toISOString()
              }
            ]
          }
        });
      if (pathname === `${directory}/stale.json`)
        return route.fulfill({
          json: {
            source: 'timekeeper-codex-bridge',
            updatedAt: new Date(now + 60000).toISOString(),
            records: [
              record,
              { ...record, id: 'codex-zero-work' },
              {
                ...record,
                id: 'codex-outdated-helper',
                codexBackfill: true,
                startTime: '2026-11-05T12:00:00Z',
                endTime: '2026-11-05T13:00:00Z'
              }
            ]
          }
        });
      return route.fulfill({ status: 404, json: {} });
    });
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
    await page.goto('/#entries');
    await expect
      .poll(
        async () =>
          (await read()).entries.find((row) => row.id === entry.id)?.duration
      )
      .toBe(600);
    let saved = await read();
    expect(saved.entries).toHaveLength(2);
    expect(saved.entries.find((row) => row.id === entry.id)).toMatchObject({
      notes: 'User note',
      custom: { preserve: true },
      codexActivityPolicyVersion: 1,
      elapsedSeconds: 1200
    });
    expect(saved.codexReconciliationHistory[0].removed[0].entry.notes).toBe(
      'User note'
    );
    expect(
      saved.codexIntegration.lastImportSummary.outdatedActivityRecords
    ).toBe(1);
    resumed = true;
    await page.reload();
    await expect
      .poll(
        async () =>
          (await read()).entries.find((row) => row.id === entry.id)?.externalId
      )
      .toBe('codex-resumed-id');
    saved = await read();
    expect(saved.entries).toHaveLength(2);
    expect(saved.entries.find((row) => row.id === entry.id)).toMatchObject({
      duration: 700,
      notes: 'User note',
      custom: { preserve: true }
    });
    expect(saved.codexIntegration.retractedCodexRecordIds).toContain(record.id);
    withRepair = false;
    await page.reload();
    await expect
      .poll(
        async () => (await read()).codexIntegration.lastImportSummary.skipped
      )
      .toBe(3);
    saved = await read();
    expect(saved.entries).toHaveLength(2);
    expect(saved.entries.find((row) => row.id === entry.id).duration).toBe(700);
    expect(saved.entries.find((row) => row.id === 'manual').duration).toBe(
      1800
    );
    expect(saved.codexReconciliationHistory[0].removed[0].entry.custom).toEqual(
      { preserve: true }
    );
    expect(errors).toEqual([]);
  });
}

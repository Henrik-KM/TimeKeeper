const { expect, test } = require('@playwright/test');

for (const width of [390, 1280]) {
  test(`email-helper focus migrates all history and survives stale imports at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const now = Date.now();
    const historicalStart = new Date(now - 400 * 86400000).toISOString();
    const historicalEnd = new Date(
      now - 400 * 86400000 + 3600000
    ).toISOString();
    const cases = [
      { model: 'gpt-6-luna', base: 0.3, expected: 0.15 },
      { model: 'gpt-6.1-terra', base: 0.4, expected: 0.2 },
      { model: 'gpt-6.1-sol', base: 0.5, expected: 0.25 },
      { model: 'gpt-6-astra', base: 0.75, expected: 0.375 },
      { model: 'gpt-6.1-sol', base: 0.6, fastMode: true, expected: 0.3 }
    ];
    const historical = cases.map((item, index) => ({
      id: `historical-${index}`,
      externalId: `codex-email-${index}`,
      projectId: index === 0 ? 'archived' : 'iflai',
      source: 'codex',
      description: 'Codex: email-helper',
      codexRepoName: 'email-helper',
      startTime: historicalStart,
      endTime: historicalEnd,
      elapsedSeconds: 3600,
      duration: Math.floor(3600 * item.base),
      focusFactor: item.base,
      manualFactor: item.base,
      codexFocusPolicyVersion: 7,
      repositoryFocusMultiplier: 1,
      isRunning: false,
      customMetadata: { keep: index },
      codexModelBreakdown: [
        {
          model: item.model,
          fastMode: item.fastMode || false,
          wallSeconds: 3600,
          factor: item.base,
          effectiveSeconds: Math.floor(3600 * item.base)
        }
      ]
    }));
    const alreadyWeighted = {
      ...historical[2],
      id: 'already-weighted',
      externalId: 'codex-already-weighted',
      duration: 900,
      focusFactor: 0.25,
      manualFactor: 0.25,
      repositoryFocusMultiplier: 0.5,
      codexModelBreakdown: [
        {
          ...historical[2].codexModelBreakdown[0],
          repositoryMultiplier: 0.5,
          factor: 0.25,
          effectiveSeconds: 900
        }
      ]
    };
    const unrelated = {
      ...historical[2],
      id: 'unrelated-repo',
      externalId: 'codex-unrelated-repo',
      codexRepoName: 'other-repo'
    };
    const manual = {
      ...historical[2],
      id: 'manual',
      externalId: undefined,
      source: 'manual',
      description: 'Manual email work',
      codexModelBreakdown: [],
      duration: 3600,
      focusFactor: 1,
      manualFactor: 1
    };
    const profile = {
      projects: [
        {
          id: 'iflai',
          name: 'IFLAI',
          budgetHours: 200,
          startDate: '2025-01-01',
          deadline: '2027-01-01'
        },
        {
          id: 'archived',
          name: 'Archived',
          archived: true,
          budgetHours: 200,
          startDate: '2025-01-01',
          deadline: '2027-01-01'
        }
      ],
      entries: [...historical, alreadyWeighted, unrelated, manual],
      codexIntegration: {
        enabled: true,
        contextSyncEnabled: false,
        repository: 'Henrik-KM/TimeKeeper',
        branch: 'main',
        inboxPath: 'assets/timekeeper-codex-inbox'
      }
    };
    let records = [];
    await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
    await page.route('**/assets/strava.json', (route) => route.abort());
    await page.route('https://api.github.com/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/contents/assets/timekeeper-codex-inbox?')) {
        return route.fulfill({
          json: [
            {
              type: 'file',
              name: 'email-focus.json',
              url: 'https://api.github.com/email-focus-test-feed'
            }
          ]
        });
      }
      if (url.endsWith('/email-focus-test-feed')) {
        return route.fulfill({
          json: {
            source: 'timekeeper-codex-bridge',
            updatedAt: new Date(now).toISOString(),
            records
          }
        });
      }
      return route.fulfill({ status: 404, json: {} });
    });
    await page.addInitScript((initialProfile) => {
      if (!localStorage.getItem('timekeeperDataPro')) {
        localStorage.setItem(
          'timekeeperDataPro',
          JSON.stringify(initialProfile)
        );
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
    await expect
      .poll(async () => (await read()).codexIntegration.codexPolicyMigration)
      .toMatchObject({ updated: cases.length, unable: 0 });

    const verifyHistory = async () => {
      const saved = await read();
      cases.forEach((item, index) => {
        expect(
          saved.entries.find((entry) => entry.id === `historical-${index}`)
        ).toMatchObject({
          externalId: historical[index].externalId,
          startTime: historicalStart,
          endTime: historicalEnd,
          elapsedSeconds: 3600,
          duration: Math.floor(3600 * item.expected),
          focusFactor: item.expected,
          manualFactor: item.expected,
          repositoryFocusMultiplier: 0.5,
          customMetadata: { keep: index }
        });
      });
      expect(
        saved.entries.find((entry) => entry.id === 'already-weighted')
      ).toMatchObject({ duration: 900, focusFactor: 0.25 });
      expect(
        saved.entries.find((entry) => entry.id === unrelated.id)
      ).toMatchObject({ duration: 1800, focusFactor: 0.5 });
      expect(
        saved.entries.find((entry) => entry.id === manual.id)
      ).toMatchObject({ duration: 3600, focusFactor: 1 });
    };
    await verifyHistory();

    const asRecord = (entry, overrides = {}) => ({
      id: entry.externalId,
      activityPolicyVersion: 1,
      repoName: 'email-helper',
      timekeeperProjectId: 'iflai',
      description: 'Codex: email-helper',
      startTime: entry.startTime,
      endTime: entry.endTime,
      wallSeconds: 3600,
      effectiveSeconds: entry.duration,
      focusFactor: entry.focusFactor,
      focusPolicyVersion: 7,
      modelBreakdown: entry.codexModelBreakdown,
      ...overrides
    });
    const recentStart = new Date(now - 7200000).toISOString();
    const recentEnd = new Date(now - 3600000).toISOString();
    records = [
      asRecord(historical[2]),
      asRecord(historical[2], {
        id: 'codex-new-email',
        startTime: recentStart,
        endTime: recentEnd
      }),
      asRecord(alreadyWeighted, {
        id: 'codex-new-already-weighted',
        startTime: recentStart,
        endTime: recentEnd
      })
    ];
    await page.reload();
    await expect
      .poll(async () => (await read()).codexIntegration.lastImportSummary)
      .toMatchObject({ imported: 2 });
    await verifyHistory();
    let saved = await read();
    for (const id of ['codex-new-email', 'codex-new-already-weighted']) {
      expect(
        saved.entries.find((entry) => entry.externalId === id)
      ).toMatchObject({ duration: 900, focusFactor: 0.25 });
    }
    await page.reload();
    await expect
      .poll(async () => (await read()).codexIntegration.lastImportSummary)
      .toMatchObject({ imported: 0, updated: 0 });
    await verifyHistory();
    records = [];
    await page.reload();
    saved = await read();
    expect(saved.entries).toHaveLength(profile.entries.length + 2);
    await verifyHistory();
    expect(errors).toEqual([]);
  });
}

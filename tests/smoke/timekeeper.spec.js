const { expect, test } = require('@playwright/test');

function seedLocalStorage(page, payload = null) {
  return page.addInitScript((initialPayload) => {
    localStorage.clear();
    if (initialPayload) {
      localStorage.setItem('timekeeperDataPro', JSON.stringify(initialPayload));
    }
  }, payload);
}

function freezeTime(page, isoString) {
  return page.addInitScript((fixedIso) => {
    const RealDate = Date;
    const fixedTime = new RealDate(fixedIso).getTime();
    class FixedDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) {
          super(fixedTime);
        } else if (args.length === 1) {
          super(args[0]);
        } else if (args.length === 2) {
          super(args[0], args[1]);
        } else if (args.length === 3) {
          super(args[0], args[1], args[2]);
        } else if (args.length === 4) {
          super(args[0], args[1], args[2], args[3]);
        } else if (args.length === 5) {
          super(args[0], args[1], args[2], args[3], args[4]);
        } else if (args.length === 6) {
          super(args[0], args[1], args[2], args[3], args[4], args[5]);
        } else {
          super(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
        }
      }
      static now() {
        return fixedTime;
      }
    }
    FixedDate.parse = RealDate.parse;
    FixedDate.UTC = RealDate.UTC;
    // @ts-expect-error FixedDate intentionally omits Date's callable string overload in browser tests.
    window.Date = FixedDate;
  }, isoString);
}

async function gotoSection(page, sectionId, headingText) {
  await page.locator(`#navList li[data-section="${sectionId}"]`).click();
  await expect(
    page.getByRole('heading', { name: headingText, exact: true })
  ).toBeVisible();
}

function projectFixture(overrides = {}) {
  return {
    id: overrides.id || 'project',
    name: overrides.name || 'Project',
    client: overrides.client || 'Client',
    budgetHours: overrides.budgetHours ?? 40,
    hourlyRate: overrides.hourlyRate ?? 100,
    startDate: overrides.startDate || '2026-04-01',
    deadline: overrides.deadline || '2026-05-31',
    createdAt: overrides.createdAt || '2026-04-01T08:00:00.000',
    color: overrides.color || '#2563eb',
    roundingMinutes: overrides.roundingMinutes ?? 0
  };
}

function entryFixture(overrides = {}) {
  const hours = overrides.hours ?? 1;
  return {
    id: overrides.id || `entry-${Math.random()}`,
    projectId: overrides.projectId || 'project',
    description: overrides.description || '',
    startTime: overrides.startTime || '2026-04-01T09:00:00.000',
    endTime: overrides.endTime || '2026-04-01T10:00:00.000',
    duration: hours * 3600,
    isRunning: false,
    createdAt:
      overrides.createdAt || overrides.startTime || '2026-04-01T10:00:00.000',
    ...(overrides.manualFactor !== undefined
      ? { manualFactor: overrides.manualFactor }
      : {}),
    ...(overrides.focusFactor !== undefined
      ? { focusFactor: overrides.focusFactor }
      : {})
  };
}

function queuePromptResponses(page, responses) {
  const pending = [...responses];
  const handler = async (dialog) => {
    if (dialog.type() === 'prompt') {
      await dialog.accept(String(pending.shift() ?? ''));
    } else {
      await dialog.accept();
    }
    if (pending.length === 0) {
      page.off('dialog', handler);
    }
  };
  page.on('dialog', handler);
}

test('boots with saved data and navigation still works', async ({ page }) => {
  await seedLocalStorage(page, {
    projects: [
      {
        id: 'seed-project',
        name: 'Seeded Project',
        client: 'Seed Client',
        budgetHours: 40,
        hourlyRate: 120,
        startDate: '2026-03-01',
        deadline: '2026-12-31',
        createdAt: '2026-03-01T08:00:00.000Z',
        color: '#2563eb',
        roundingMinutes: 0
      }
    ],
    entries: [
      {
        id: 'seed-entry',
        projectId: 'seed-project',
        description: 'Seeded work',
        startTime: '2026-04-23T09:00:00.000Z',
        endTime: '2026-04-23T11:00:00.000Z',
        duration: 7200,
        isRunning: false,
        createdAt: '2026-04-23T11:00:00.000Z'
      }
    ]
  });

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Timer', exact: true })
  ).toBeVisible();

  await gotoSection(page, 'dashboard', 'Dashboard');
  await expect(
    page.locator('#detailedBreakdown').getByText('Seeded Project')
  ).toBeVisible();

  await gotoSection(page, 'entries', 'Time Entries');
  await expect(page.getByText('Seeded work')).toBeVisible();

  await gotoSection(page, 'todo', 'Workouts');
  await gotoSection(page, 'grocery', 'Finances');
  await gotoSection(page, 'analytics', 'Reports');
  await expect(page.locator('#hoursByProjectChart')).toBeVisible();
});

test('can create edit and delete a project, then run timer and manual entry flows', async ({
  page
}) => {
  await seedLocalStorage(page);
  await page.goto('/');

  await gotoSection(page, 'projects', 'Projects');

  await page.locator('#projectNamePro').fill('Alpha Project');
  await page.locator('#projectClientPro').fill('Acme');
  await page.locator('#projectBudgetPro').fill('160');
  await page.locator('#projectRatePro').fill('100');
  await page.locator('#projectRoundingPro').selectOption('10');
  await page.locator('#projectStartDatePro').fill('2026-04-01');
  await page.locator('#projectDeadlinePro').fill('2026-08-31');
  await page.locator('#projectFormPro button[type="submit"]').click();

  await expect(
    page.getByRole('heading', { name: 'Alpha Project', exact: true })
  ).toBeVisible();

  queuePromptResponses(page, [
    'Alpha Project Updated',
    'Acme Updated',
    '180',
    '125',
    'deadline',
    '2026-04-01',
    '2026-09-30',
    '15'
  ]);
  await page.locator('.edit-btn').first().click();
  await expect(
    page.getByRole('heading', { name: 'Alpha Project Updated', exact: true })
  ).toBeVisible();

  await gotoSection(page, 'timer', 'Timer');
  await page.locator('#timerProjectPro').selectOption({ index: 0 });
  await page.locator('#timerInitialPro').fill('0.5');
  await page.locator('#startTimerBtnPro').click();
  await expect(page.getByText('Running Timers')).toBeVisible();
  await page.getByRole('button', { name: 'Stop All Timers' }).click();

  await gotoSection(page, 'entries', 'Time Entries');
  await page.locator('#addManualEntryBtnPro').click();
  await page
    .locator('#manualProjectPro')
    .selectOption({ label: 'Alpha Project Updated' });
  await page.locator('#manualDescriptionPro').fill('Manual work');
  await page.locator('#manualHoursPro').fill('2');
  await page.locator('#manualFormPro button[type="submit"]').click();
  await expect(page.getByText('Manual work')).toBeVisible();

  await gotoSection(page, 'analytics', 'Reports');
  await expect(page.locator('#hoursByProjectChart')).toBeVisible();

  page.once('dialog', async (dialog) => {
    await dialog.accept();
  });
  await gotoSection(page, 'projects', 'Projects');
  await page.locator('.delete-btn').first().click();
  await expect(page.getByText('No projects yet.')).toBeVisible();
});

test('can create a weekly pace project without a deadline', async ({
  page
}) => {
  await seedLocalStorage(page);
  await page.goto('/');

  await gotoSection(page, 'projects', 'Projects');

  await page.locator('#projectNamePro').fill('Support Retainer');
  await page.locator('#projectClientPro').fill('Acme');
  await page.locator('#projectScheduleTypePro').selectOption('weekly');
  await page.locator('#projectWeeklyHoursPro').fill('12');
  await page.locator('#projectRatePro').fill('150');
  await page.locator('#projectStartDatePro').fill('2026-04-01');
  await page.locator('#projectFormPro button[type="submit"]').click();

  const card = page
    .getByRole('heading', { name: 'Support Retainer', exact: true })
    .locator('..');
  await expect(card).toContainText('12.0h/week');
  await expect(card).toContainText('Deadline: None');

  await gotoSection(page, 'timer', 'Timer');
  await expect(page.locator('#timerProjectPro')).toContainText(
    'Support Retainer'
  );
});

test('import and export still work', async ({ page }) => {
  await seedLocalStorage(page, {
    projects: [
      {
        id: 'export-project',
        name: 'Exportable',
        client: 'Client',
        budgetHours: 12,
        hourlyRate: 90,
        startDate: '2026-04-01',
        deadline: '2026-04-30',
        createdAt: '2026-04-01T08:00:00.000Z',
        color: '#2563eb'
      }
    ],
    entries: []
  });
  await page.goto('/');
  await gotoSection(page, 'importExport', 'Import / Export');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportBtnPro').click();
  const download = await downloadPromise;
  await expect(download.suggestedFilename()).toContain(
    'timekeeper-offline-data'
  );

  const importPayload = {
    projects: [
      {
        id: 'import-project',
        name: 'Imported Project',
        client: 'Imported Client',
        budgetHours: 25,
        hourlyRate: 150,
        startDate: '2026-04-01',
        deadline: '2026-05-31',
        createdAt: '2026-04-01T09:00:00.000Z',
        color: '#dc2626'
      }
    ],
    entries: []
  };

  page.once('dialog', async (dialog) => {
    await dialog.accept();
  });
  await page.locator('#importInputPro').setInputFiles({
    name: 'import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(importPayload), 'utf-8')
  });

  await gotoSection(page, 'projects', 'Projects');
  await expect(
    page.getByRole('heading', { name: 'Imported Project', exact: true })
  ).toBeVisible();
});

test('entry filters summarize visible work and match project/search text', async ({
  page
}) => {
  await freezeTime(page, '2026-04-26T12:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'alpha',
        name: 'Alpha Project',
        client: 'Acme',
        hourlyRate: 100
      }),
      projectFixture({
        id: 'beta',
        name: 'Beta Project',
        client: 'Beta Co',
        hourlyRate: 200
      })
    ],
    entries: [
      entryFixture({
        id: 'alpha-entry',
        projectId: 'alpha',
        description: 'Design review',
        startTime: '2026-04-25T09:00:00.000',
        endTime: '2026-04-25T11:00:00.000',
        hours: 2
      }),
      entryFixture({
        id: 'beta-entry',
        projectId: 'beta',
        description: 'Admin follow up',
        startTime: '2026-04-25T12:00:00.000',
        endTime: '2026-04-25T13:00:00.000',
        hours: 1
      })
    ]
  });

  await page.goto('/');
  await gotoSection(page, 'entries', 'Time Entries');

  await expect(page.locator('#toggleEntriesViewBtn')).toHaveText('Show All');
  await expect(page.locator('#entrySummaryPro')).toContainText('2 entries');
  await expect(page.locator('#entrySummaryPro')).toContainText('3h 0m 0s');
  await expect(page.locator('#entrySummaryPro')).toContainText('400.0 kr');

  await page.locator('#entryProjectFilter').selectOption('alpha');
  await expect(page.locator('#entrySummaryPro')).toContainText('1 entry');
  await expect(page.getByText('Design review')).toBeVisible();
  await expect(page.getByText('Admin follow up')).not.toBeVisible();

  await page.locator('#entrySearchInput').fill('acme');
  await expect(page.getByText('Design review')).toBeVisible();
  await page.locator('#entrySearchInput').fill('missing');
  await expect(
    page.getByText('No entries match the current filters.')
  ).toBeVisible();
});

test('entries render saved descriptions without executing markup', async ({
  page
}) => {
  await freezeTime(page, '2026-04-26T12:00:00');
  await page.addInitScript(() => {
    window['__timekeeperXssFired'] = false;
  });
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'unsafe-project',
        name: 'Unsafe Project',
        client: 'Client'
      })
    ],
    entries: [
      entryFixture({
        id: 'unsafe-entry',
        projectId: 'unsafe-project',
        description: '<svg onload="window.__timekeeperXssFired=true"></svg>',
        startTime: '2026-04-25T09:00:00.000',
        endTime: '2026-04-25T10:00:00.000',
        hours: 1
      })
    ]
  });

  await page.goto('/');
  await gotoSection(page, 'entries', 'Time Entries');

  await expect(page.locator('#entriesTableBodyPro')).toContainText(
    '<svg onload'
  );
  await expect
    .poll(() => page.evaluate(() => window['__timekeeperXssFired']), {
      timeout: 2000
    })
    .toBe(false);
});

test('workout, finances, wealth, and Strava fallback paths still render', async ({
  page
}) => {
  await seedLocalStorage(page);
  await page.route('**/assets/strava.json', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });
  await page.goto('/');

  await gotoSection(page, 'todo', 'Workouts');
  await page.locator('#todoName').fill('Morning Ride');
  await page.locator('#todoIntensity').selectOption('medium');
  await page.locator('#todoForm button[type="submit"]').click();
  await expect(page.getByText('Morning Ride')).toBeVisible();
  await expect(page.locator('#stravaFeedStatus')).toContainText(
    'Strava feed not available yet'
  );

  await gotoSection(page, 'grocery', 'Finances');
  await page.locator('#monthlyPaymentName').fill('Gym');
  await page.locator('#monthlyPaymentAmount').fill('50');
  await page.locator('#monthlyRecurringForm button[type="submit"]').click();
  await expect(page.getByText(/Gym/)).toBeVisible();

  await page.locator('#groceryName').fill('Protein');
  await page.locator('#groceryFreq').selectOption('weekly');
  await page.locator('#groceryForm button[type="submit"]').click();
  await expect(page.getByText('Protein')).toBeVisible();

  await page.locator('#wealthEntryDate').fill('2026-04-01');
  await page.locator('#wealthEntryAmount').fill('100000');
  await page.locator('#wealthEntryNote').fill('Deposit');
  await page.locator('#wealthEntryForm button[type="submit"]').click();
  await expect(page.getByText('Deposit')).toBeVisible();
});

test('weekly project targets spend rolling 30-day surplus before showing behind', async ({
  page
}) => {
  await freezeTime(page, '2026-04-24T12:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'anders',
        name: 'Anders',
        budgetHours: 100,
        startDate: '2026-04-01',
        deadline: '2026-05-31'
      })
    ],
    entries: [
      entryFixture({
        id: 'anders-rolling-work',
        projectId: 'anders',
        startTime: '2026-04-10T09:00:00.000',
        endTime: '2026-04-10T11:00:00.000',
        hours: 50
      }),
      entryFixture({
        id: 'anders-week-work',
        projectId: 'anders',
        startTime: '2026-04-22T09:00:00.000',
        endTime: '2026-04-22T11:00:00.000',
        hours: 2
      })
    ]
  });

  await page.goto('/');
  await gotoSection(page, 'dashboard', 'Dashboard');

  await expect(page.locator('#statsGrid')).toContainText('Anders: 2.0 / 0.0h');
});

test('timer recommendation uses the project with the most hours left today', async ({
  page
}) => {
  await freezeTime(page, '2026-04-24T12:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'anders',
        name: 'Anders',
        budgetHours: 100,
        startDate: '2026-04-01',
        deadline: '2026-05-31'
      }),
      projectFixture({
        id: 'beta',
        name: 'Beta',
        budgetHours: 60,
        startDate: '2026-04-01',
        deadline: '2026-05-31',
        color: '#dc2626'
      })
    ],
    entries: [
      entryFixture({
        id: 'anders-rolling-work',
        projectId: 'anders',
        startTime: '2026-04-10T09:00:00.000',
        endTime: '2026-04-10T11:00:00.000',
        hours: 50
      }),
      entryFixture({
        id: 'anders-week-work',
        projectId: 'anders',
        startTime: '2026-04-22T09:00:00.000',
        endTime: '2026-04-22T11:00:00.000',
        hours: 2
      })
    ]
  });

  await page.goto('/');

  await expect(page.locator('#timerProjectPro option').first()).toContainText(
    /Beta.*Recommended.*today/
  );
  await expect(page.locator('#timerRecommendationPro')).toContainText(
    /Recommended: Beta .*h left today/
  );
});

test('daily and weekly targets stay fixed while logging time during the day', async ({
  page
}) => {
  await freezeTime(page, '2026-04-24T10:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'stable-project',
        name: 'Stable Project',
        budgetHours: 80,
        startDate: '2026-04-01',
        deadline: '2026-05-31'
      })
    ],
    entries: []
  });

  await page.goto('/');
  await gotoSection(page, 'dashboard', 'Dashboard');

  const todayValue = page
    .locator('.stat-card')
    .filter({ hasText: "Today's Hours" })
    .locator('.stat-value');
  const weekValue = page
    .locator('.stat-card')
    .filter({ hasText: 'This Week' })
    .locator('.stat-value');
  const beforeTodayTarget = (await todayValue.textContent())
    .split('/')[1]
    .trim();
  const beforeWeekTarget = (await weekValue.textContent()).split('/')[1].trim();

  await gotoSection(page, 'entries', 'Time Entries');
  await page.locator('#addManualEntryBtnPro').click();
  await page.locator('#manualProjectPro').selectOption('stable-project');
  await page.locator('#manualHoursPro').fill('2');
  await page.locator('#manualFormPro button[type="submit"]').click();

  await gotoSection(page, 'dashboard', 'Dashboard');
  const afterTodayTarget = (await todayValue.textContent())
    .split('/')[1]
    .trim();
  const afterWeekTarget = (await weekValue.textContent()).split('/')[1].trim();

  expect(afterTodayTarget).toBe(beforeTodayTarget);
  expect(afterWeekTarget).toBe(beforeWeekTarget);
});

test('time left today counts initial elapsed time correctly at 50 percent focus', async ({
  page
}) => {
  await freezeTime(page, '2026-04-24T10:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'today-project',
        name: 'Today Project',
        budgetHours: 2,
        startDate: '2026-04-24',
        deadline: '2026-04-24'
      })
    ],
    entries: []
  });

  await page.goto('/');
  await page.locator('#timerProjectPro').selectOption('today-project');
  await page.locator('#timerInitialPro').fill('1');
  await page.locator('#startFactorPro').selectOption('0.5');
  await page.locator('#startTimerBtnPro').click();

  await expect(page.locator('#runningTimeLeftToday')).toHaveText('2h 0m 0s');
});

test('recent timer chips preserve focus and start immediately', async ({
  page
}) => {
  await freezeTime(page, '2026-04-24T10:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'agent-project',
        name: 'Agent Project',
        budgetHours: 8,
        startDate: '2026-04-24',
        deadline: '2026-04-24'
      })
    ],
    entries: [
      entryFixture({
        id: 'agent-previous',
        projectId: 'agent-project',
        startTime: '2026-04-23T09:00:00.000',
        endTime: '2026-04-23T10:00:00.000',
        createdAt: '2026-04-23T10:00:00.000',
        hours: 1,
        manualFactor: 0.5,
        focusFactor: 0.5
      })
    ]
  });

  await page.goto('/');
  await expect(page.locator('#startFactorPro')).toContainText('150%');
  await expect(page.locator('#startFactorPro')).toContainText('200%');

  await page.getByRole('button', { name: 'Agent Project - 50%' }).click();

  await expect(page.locator('[id^="runningFactor-"]').first()).toHaveText(
    '50%'
  );
});

test('focus blocker sends blocked websites once paid focus exceeds 50 percent', async ({
  page
}) => {
  await freezeTime(page, '2026-04-24T10:00:00');
  await page.addInitScript(() => {
    window['__focusWebhookUrls'] = [];
    const record = (url) => {
      window['__focusWebhookUrls'].push(String(url));
    };
    window.fetch = (url) => {
      record(url);
      return Promise.resolve(new Response('', { status: 204 }));
    };
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: (url) => {
        record(url);
        return true;
      }
    });
  });
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'paid-project',
        name: 'Paid Project',
        budgetHours: 8,
        startDate: '2026-04-24',
        deadline: '2026-04-24'
      })
    ],
    entries: []
  });

  await page.goto('/');
  await page.locator('#timerProjectPro').selectOption('paid-project');
  await page.locator('#startFactorPro').selectOption('1.5');
  await page.locator('#startTimerBtnPro').click();

  await expect
    .poll(async () => {
      return page.evaluate(() =>
        (window['__focusWebhookUrls'] || []).join('\n')
      );
    })
    .toMatch(
      /\/focus\/start.*paidFocus=150.*blockedSites=.*reddit\.com.*youtube\.com/
    );
});

test('auto-sync unsupported state still renders safely', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: undefined
    });
  });

  await page.goto('/');
  await gotoSection(page, 'importExport', 'Import / Export');
  await expect(page.locator('#autoSyncToggle')).toBeDisabled();
  await expect(page.locator('#backupNowBtn')).toBeDisabled();
  await expect(page.locator('#restoreBackupBtn')).toBeDisabled();
  await expect(page.locator('#autoSyncWarning')).toContainText(
    'Auto sync unavailable'
  );
});

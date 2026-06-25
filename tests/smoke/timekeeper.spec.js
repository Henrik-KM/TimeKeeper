const { expect, test } = require('@playwright/test');
const { readFile } = require('node:fs/promises');

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
  const navItem = page.locator(`#navList li[data-section="${sectionId}"]`);
  const heading = page.getByRole('heading', {
    name: headingText,
    exact: true
  });
  await navItem.click();
  try {
    await expect(heading).toBeVisible({ timeout: 3000 });
  } catch {
    await navItem.click({ force: true });
    await expect(heading).toBeVisible();
  }
}

async function expandDetails(container, summaryText) {
  const details = container.locator('details').filter({ hasText: summaryText });
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
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

test('boots with saved data and navigation still works', async ({ page }) => {
  await freezeTime(page, '2026-04-23T12:00:00');
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
  await expect(page.locator('#entriesTableBodyPro')).toContainText(
    'Seeded work'
  );

  await gotoSection(page, 'todo', 'Workouts');
  await gotoSection(page, 'grocery', 'Finances');
  await gotoSection(page, 'analytics', 'Reports');
  await expect(page.locator('#hoursByProjectChart')).toBeVisible();
});

test('dashboard app health summarizes data, backup, Strava, blocker, and offline status', async ({
  page
}) => {
  await freezeTime(page, '2026-04-23T12:00:00');
  await page.route('**/assets/strava.json', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        updated_utc: '2026-04-23T10:00:00.000Z',
        activities: [
          {
            id: 123,
            name: 'Morning Run',
            type: 'Run',
            start_date: '2026-04-23T08:00:00.000Z',
            moving_time: 1800,
            elapsed_time: 1900,
            distance: 5000
          }
        ]
      })
    });
  });
  await seedLocalStorage(page, {
    projects: [
      projectFixture({ id: 'health-project', name: 'Health Project' })
    ],
    entries: [entryFixture({ projectId: 'health-project', hours: 2 })],
    backupRevision: 7,
    updatedAt: '2026-04-23T09:30:00.000Z',
    lastBackupAt: '2026-04-23T09:45:00.000Z',
    lastBackupSnapshotAt: '2026-04-23T09:45:00.000Z',
    backupDirName: 'TimeKeeper Backups'
  });

  await page.goto('/');
  await gotoSection(page, 'dashboard', 'Dashboard');
  const health = page.locator('#appHealthPanel');
  await expect(health).toContainText('App Health');
  await expect(health).toContainText('Local Data');
  await expect(health).toContainText('1 projects, 1 entries');
  await expect(health).toContainText('revision');
  await expect(health).toContainText('Backup Sync');
  await expect(health).toContainText('Snapshots');
  await expect(health).toContainText('Strava Feed');
  await expect(health).toContainText('1 activities');
  await expect(health).toContainText('Desktop Blocker');
  await expect(health).toContainText('Offline App');
  await expandDetails(health, 'App Health');
  await expect(health).toContainText('Self-Test');
});

test('dashboard app health can repair local data integrity issues', async ({
  page
}) => {
  await freezeTime(page, '2026-06-03T12:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({ id: 'valid-project', name: 'Valid Project' }),
      projectFixture({ id: 'duplicate-project', name: 'Duplicate A' }),
      projectFixture({ id: 'duplicate-project', name: 'Duplicate B' })
    ],
    entries: [
      entryFixture({
        id: 'valid-entry',
        projectId: 'valid-project',
        description: 'Valid work',
        startTime: '2026-06-03T08:00:00.000',
        endTime: '2026-06-03T09:00:00.000',
        hours: 1
      }),
      entryFixture({
        id: 'orphan-entry',
        projectId: 'missing-project',
        description: 'Orphan work',
        startTime: '2026-06-03T09:00:00.000',
        endTime: '2026-06-03T10:00:00.000',
        hours: 1
      }),
      entryFixture({
        id: 'duplicate-entry',
        projectId: 'valid-project',
        description: 'Duplicate one',
        startTime: '2026-06-03T10:00:00.000',
        endTime: '2026-06-03T11:00:00.000',
        hours: 1
      }),
      entryFixture({
        id: 'duplicate-entry',
        projectId: 'valid-project',
        description: 'Duplicate two',
        startTime: '2026-06-03T11:00:00.000',
        endTime: '2026-06-03T12:00:00.000',
        hours: 1
      }),
      {
        id: 'invalid-stopped',
        projectId: 'valid-project',
        description: 'Broken duration',
        startTime: '2026-06-03T09:00:00.000',
        endTime: '2026-06-03T11:00:00.000',
        duration: -30,
        isRunning: false,
        createdAt: '2026-06-03T11:00:00.000',
        focusFactor: 0.5,
        manualFactor: 0.5
      },
      {
        id: 'bad-focus',
        projectId: 'valid-project',
        description: 'Bad focus',
        startTime: '2026-06-03T09:00:00.000',
        endTime: '2026-06-03T10:00:00.000',
        duration: 3600,
        isRunning: false,
        createdAt: '2026-06-03T10:00:00.000',
        focusFactor: -1,
        manualFactor: 0
      },
      {
        id: 'bad-running',
        projectId: 'valid-project',
        description: 'Invalid running',
        startTime: 'not-a-date',
        endTime: null,
        duration: null,
        isRunning: true,
        createdAt: '2026-06-03T10:00:00.000',
        focusFactor: 1,
        manualFactor: 1
      },
      {
        id: 'stale-running',
        projectId: 'valid-project',
        description: 'Review me',
        startTime: '2026-06-02T10:00:00.000',
        endTime: null,
        duration: null,
        isRunning: true,
        createdAt: '2026-06-02T10:00:00.000',
        effectiveSeconds: 0,
        lastUpdateTime: '2026-06-02T10:00:00.000',
        focusFactor: 1,
        manualFactor: 1
      }
    ]
  });

  await page.goto('/');
  await gotoSection(page, 'dashboard', 'Dashboard');
  const health = page.locator('#appHealthPanel');
  await expect(health).toContainText('Local Data');
  await expect(health).toContainText('Issues');
  await expect(health).toContainText('orphan entries');
  await expandDetails(health, 'App Health');
  await expect(
    health.getByRole('button', { name: 'Repair Data' })
  ).toBeVisible();

  await health.getByRole('button', { name: 'Repair Data' }).click();
  await page
    .getByRole('dialog', { name: 'Repair Local Data' })
    .getByRole('button', { name: 'Repair Data' })
    .click();

  const repaired = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('timekeeperDataPro'));
    const entryIds = saved.entries.map((entry) => entry.id);
    const projectIds = saved.projects.map((project) => project.id);
    return {
      projectIdsUnique: new Set(projectIds).size === projectIds.length,
      entryIdsUnique: new Set(entryIds).size === entryIds.length,
      orphanExists: saved.entries.some(
        (entry) => entry.description === 'Orphan work'
      ),
      invalidRunningExists: saved.entries.some(
        (entry) => entry.id === 'bad-running'
      ),
      invalidStoppedDuration: saved.entries.find(
        (entry) => entry.id === 'invalid-stopped'
      ).duration,
      badFocus: saved.entries.find((entry) => entry.id === 'bad-focus'),
      staleRunning: saved.entries.find((entry) => entry.id === 'stale-running')
    };
  });

  expect(repaired.projectIdsUnique).toBe(true);
  expect(repaired.entryIdsUnique).toBe(true);
  expect(repaired.orphanExists).toBe(false);
  expect(repaired.invalidRunningExists).toBe(false);
  expect(repaired.invalidStoppedDuration).toBe(3600);
  expect(repaired.badFocus.focusFactor).toBe(1);
  expect(repaired.badFocus.manualFactor).toBe(1);
  expect(repaired.staleRunning.isRunning).toBe(true);

  await expect(health).toContainText('Review');
  await expect(health).toContainText('running timers need review');
  await expandDetails(health, 'App Health');
  await health.getByRole('button', { name: 'Review Timers' }).click();
  await expect(
    page.getByRole('heading', { name: 'Timer', exact: true })
  ).toBeVisible();
  await expect(page.locator('#runningTimerPro')).toContainText('Review me');
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

  await page.locator('.edit-btn').first().click();
  let editModal = page.getByRole('dialog', { name: 'Edit Project' });
  await expect(editModal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editModal).toBeHidden();

  await page.locator('.edit-btn').first().click();
  editModal = page.getByRole('dialog', { name: 'Edit Project' });
  await expect(editModal).toBeVisible();
  await editModal.locator('#name').fill('Alpha Project Updated');
  await editModal.locator('#client').fill('Acme Updated');
  await editModal.locator('#budgetHours').fill('180');
  await editModal.locator('#hourlyRate').fill('125');
  await editModal.locator('#scheduleType').selectOption('deadline');
  await editModal.locator('#startDate').fill('2026-04-01');
  await editModal.locator('#deadline').fill('2026-09-30');
  await editModal.locator('#roundingMinutes').selectOption('15');
  await editModal.getByRole('button', { name: 'Save Project' }).click();
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
  await expect(page.locator('#entriesTableBodyPro')).toContainText(
    'Manual work'
  );

  await gotoSection(page, 'analytics', 'Reports');
  await expect(page.locator('#hoursByProjectChart')).toBeVisible();

  await gotoSection(page, 'projects', 'Projects');
  await page.locator('.delete-btn').first().click();
  await expect(
    page.getByRole('dialog', { name: 'Delete Project' })
  ).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Delete Project' })
    .getByRole('button', { name: 'Delete' })
    .click();
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

test('project archive hides projects from new timers until restored', async ({
  page
}) => {
  await seedLocalStorage(page, {
    projects: [projectFixture({ id: 'archive-me', name: 'Archive Me' })],
    entries: []
  });
  await page.goto('/');

  await gotoSection(page, 'projects', 'Projects');
  const projectsSection = page.locator('#projects');
  await projectsSection
    .getByRole('button', { name: 'Archive', exact: true })
    .click();
  await expect(
    page.getByText(
      'No active projects. Show archived projects to review older work.'
    )
  ).toBeVisible();

  await gotoSection(page, 'timer', 'Timer');
  await expect(page.locator('#timerProjectPro')).toContainText(
    'no active projects'
  );

  await gotoSection(page, 'projects', 'Projects');
  await page.locator('#showArchivedProjectsToggle').check();
  await projectsSection
    .getByRole('button', { name: 'Restore', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Archive Me', exact: true })
  ).toBeVisible();
});

test('timer descriptions pause resume and edit controls are usable', async ({
  page
}) => {
  await seedLocalStorage(page, {
    projects: [projectFixture({ id: 'timer-project', name: 'Timer Project' })],
    entries: []
  });
  await page.goto('/');

  await page.locator('#timerDescriptionPro').fill('Planning work');
  await page.locator('#startFactorPro').selectOption('0.5');
  await page.locator('#startTimerBtnPro').click();
  await expect(page.getByText('Planning work')).toBeVisible();
  await expect(page.locator('#runningFocusStatus')).toContainText(
    'Paid focus: 50%'
  );

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText(/paused/)).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Edit Running Timer' });
  await expect(modal).toBeVisible();
  await modal.locator('#description').fill('Edited focus');
  await modal.locator('#focusFactor').selectOption('1');
  await modal.getByRole('button', { name: 'Save Timer' }).click();
  await expect(page.locator('#runningTimerPro')).toContainText('Edited focus');
  await expect(page.locator('#runningFocusStatus')).toContainText(
    'Paid focus: 100%'
  );
});

test('running timers warn when they look forgotten', async ({ page }) => {
  await freezeTime(page, '2026-04-26T12:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'overnight-project',
        name: 'Overnight Project'
      })
    ],
    entries: [
      {
        ...entryFixture({
          id: 'overnight-running',
          projectId: 'overnight-project',
          description: 'Forgotten timer',
          startTime: '2026-04-25T23:30:00.000',
          createdAt: '2026-04-25T23:30:00.000'
        }),
        endTime: null,
        duration: null,
        isRunning: true,
        effectiveSeconds: 0,
        lastUpdateTime: '2026-04-25T23:30:00.000',
        focusFactor: 1,
        manualFactor: 1
      }
    ]
  });

  await page.goto('/');

  const warning = page.locator('#runningTimerPro .timer-warning');
  await expect(warning).toContainText('Started before today');
  await expect(warning).toContainText('Running for');
  await expect(warning).toContainText('wall-clock');
});

test('manual entries can use start end times and focus factor', async ({
  page
}) => {
  await freezeTime(page, '2026-04-26T12:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'manual-focus-project',
        name: 'Manual Focus Project',
        hourlyRate: 100
      })
    ],
    entries: []
  });
  await page.goto('/');

  await gotoSection(page, 'entries', 'Time Entries');
  await page.locator('#addManualEntryBtnPro').click();
  await page.locator('#manualProjectPro').selectOption('manual-focus-project');
  await page.locator('#manualDescriptionPro').fill('Ranged agent work');
  await page.locator('#manualStartPro').fill('2026-04-26T09:00');
  await page.locator('#manualEndPro').fill('2026-04-26T11:00');
  await page.locator('#manualFactorPro').selectOption('0.5');
  await page.locator('#manualFormPro button[type="submit"]').click();

  const row = page
    .locator('#entriesTableBodyPro tr')
    .filter({ hasText: 'Ranged agent work' });
  await expect(row).toContainText('1h 0m 0s');
  await expect(row).toContainText('50%');
  await expect(row).toContainText('100.0 kr');

  const saved = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('timekeeperDataPro'));
    return data.entries.find(
      (entry) => entry.description === 'Ranged agent work'
    );
  });
  expect(saved.duration).toBe(3600);
  expect(saved.focusFactor).toBe(0.5);
  expect(saved.manualFactor).toBe(0.5);
});

test('stopped entries can be fully edited after they are saved', async ({
  page
}) => {
  await freezeTime(page, '2026-06-03T12:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({ id: 'alpha', name: 'Alpha Project', hourlyRate: 100 }),
      projectFixture({ id: 'beta', name: 'Beta Project', hourlyRate: 200 })
    ],
    entries: [
      entryFixture({
        id: 'entry-to-edit',
        projectId: 'alpha',
        description: 'Original work',
        startTime: '2026-06-03T08:00:00.000',
        endTime: '2026-06-03T09:00:00.000',
        hours: 1
      })
    ]
  });
  await page.goto('/');

  await gotoSection(page, 'entries', 'Time Entries');
  const row = page
    .locator('#entriesTableBodyPro tr')
    .filter({ hasText: 'Original work' });
  await row.getByRole('button', { name: 'Edit' }).click();

  const dialog = page.getByRole('dialog', { name: 'Edit Entry' });
  await expect(dialog).toBeVisible();
  await dialog.locator('#projectId').selectOption('beta');
  await dialog.locator('#description').fill('Edited agent work');
  await dialog.locator('#startTime').fill('2026-06-03T09:00');
  await dialog.locator('#endTime').fill('2026-06-03T11:00');
  await dialog.locator('#focusFactor').selectOption('0.5');
  await dialog.getByRole('button', { name: 'Save Entry' }).click();

  const editedRow = page
    .locator('#entriesTableBodyPro tr')
    .filter({ hasText: 'Edited agent work' });
  await expect(editedRow).toContainText('Beta Project');
  await expect(editedRow).toContainText('1h 0m 0s');
  await expect(editedRow).toContainText('50%');
  await expect(editedRow).toContainText('200.0 kr');

  const saved = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('timekeeperDataPro'));
    return data.entries.find((entry) => entry.id === 'entry-to-edit');
  });
  expect(saved.projectId).toBe('beta');
  expect(saved.description).toBe('Edited agent work');
  expect(saved.duration).toBe(3600);
  expect(saved.focusFactor).toBe(0.5);
  expect(saved.manualFactor).toBe(0.5);

  await editedRow.getByRole('button', { name: 'Split' }).click();
  const splitDialog = page.getByRole('dialog', { name: 'Split Entry' });
  await expect(splitDialog).toBeVisible();
  await splitDialog.locator('#splitTime').fill('2026-06-03T10:00');
  await splitDialog.locator('#firstDescription').fill('Edited agent work A');
  await splitDialog.locator('#secondDescription').fill('Edited agent work B');
  await splitDialog.getByRole('button', { name: 'Split Entry' }).click();

  await expect(
    page
      .locator('#entriesTableBodyPro tr')
      .filter({ hasText: 'Edited agent work A' })
  ).toContainText('30m 0s');
  await expect(
    page
      .locator('#entriesTableBodyPro tr')
      .filter({ hasText: 'Edited agent work B' })
  ).toContainText('30m 0s');
  const splitEntries = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('timekeeperDataPro'));
    return data.entries
      .filter((entry) => entry.description.startsWith('Edited agent work '))
      .map((entry) => ({
        id: entry.id,
        description: entry.description,
        projectId: entry.projectId,
        startTime: entry.startTime,
        endTime: entry.endTime,
        duration: entry.duration,
        focusFactor: entry.focusFactor,
        manualFactor: entry.manualFactor,
        isRunning: entry.isRunning
      }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  });
  expect(splitEntries).toHaveLength(2);
  expect(splitEntries[0]).toMatchObject({
    id: 'entry-to-edit',
    description: 'Edited agent work A',
    projectId: 'beta',
    duration: 1800,
    focusFactor: 0.5,
    manualFactor: 0.5,
    isRunning: false
  });
  expect(splitEntries[1]).toMatchObject({
    description: 'Edited agent work B',
    projectId: 'beta',
    duration: 1800,
    focusFactor: 0.5,
    manualFactor: 0.5,
    isRunning: false
  });
  expect(splitEntries[1].id).not.toBe('entry-to-edit');

  const splitSecondRow = page
    .locator('#entriesTableBodyPro tr')
    .filter({ hasText: 'Edited agent work B' });
  await splitSecondRow.getByRole('button', { name: 'Duplicate' }).click();
  await expect(
    page
      .locator('#entriesTableBodyPro tr')
      .filter({ hasText: 'Edited agent work B' })
  ).toHaveCount(2);
  const duplicatedEntries = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('timekeeperDataPro'));
    return data.entries
      .filter((entry) => entry.description === 'Edited agent work B')
      .map((entry) => ({
        id: entry.id,
        projectId: entry.projectId,
        duration: entry.duration,
        focusFactor: entry.focusFactor,
        manualFactor: entry.manualFactor,
        isRunning: entry.isRunning
      }));
  });
  expect(duplicatedEntries).toHaveLength(2);
  expect(new Set(duplicatedEntries.map((entry) => entry.id)).size).toBe(2);
  duplicatedEntries.forEach((entry) => {
    expect(entry.projectId).toBe('beta');
    expect(entry.duration).toBe(1800);
    expect(entry.focusFactor).toBe(0.5);
    expect(entry.manualFactor).toBe(0.5);
    expect(entry.isRunning).toBe(false);
  });
});

test('entry bulk tools can move selected entries and export CSV summaries', async ({
  page
}) => {
  await freezeTime(page, '2026-06-03T12:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({ id: 'alpha', name: 'Alpha Project', hourlyRate: 100 }),
      projectFixture({ id: 'beta', name: 'Beta Project', hourlyRate: 200 })
    ],
    entries: [
      entryFixture({
        id: 'entry-alpha',
        projectId: 'alpha',
        description: 'Bulk work',
        startTime: '2026-06-03T09:00:00.000Z',
        endTime: '2026-06-03T10:00:00.000Z',
        hours: 1
      }),
      entryFixture({
        id: 'entry-beta',
        projectId: 'beta',
        description: 'Summary work',
        startTime: '2026-06-03T10:00:00.000Z',
        endTime: '2026-06-03T12:00:00.000Z',
        hours: 2
      })
    ]
  });
  await page.goto('/');

  await gotoSection(page, 'entries', 'Time Entries');
  await page
    .locator('#entriesTableBodyPro tr')
    .filter({ hasText: 'Bulk work' })
    .locator('input[type="checkbox"]')
    .check();
  await page.locator('#entryBulkActions select').selectOption('beta');
  await expect(page.locator('#entriesTableBodyPro')).toContainText(
    'Beta Project'
  );

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Visible CSV' }).click();
  const visibleDownload = await download;
  await expect(visibleDownload.suggestedFilename()).toContain(
    'timekeeper-entries'
  );

  const summaryDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Summary CSV' }).click();
  const summaryDownload = await summaryDownloadPromise;
  await expect(summaryDownload.suggestedFilename()).toContain(
    'timekeeper-entry-summary'
  );
  const summaryText = await readFile(await summaryDownload.path(), 'utf-8');
  expect(summaryText).toContain(
    'Client,Project,Entries,Duration Hours,Hourly Rate,Total'
  );
  expect(summaryText).toContain('Client,Beta Project,2,3.000,200.00,600.00');
  expect(summaryText).toContain('Total,,2,3.000,,600.00');
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

test('Strava feed can be imported from JSON in the browser', async ({
  page
}) => {
  await freezeTime(page, '2026-06-03T12:00:00');
  await seedLocalStorage(page);
  await page.route('**/assets/strava.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ updated_utc: null, activities: [], error: null })
    });
  });

  await page.goto('/');
  await gotoSection(page, 'importExport', 'Import / Export');
  await page.locator('#stravaImportInput').setInputFiles({
    name: 'strava.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        updated_utc: '2026-06-03T08:00:00Z',
        activities: [
          {
            id: 998877,
            name: 'Browser Import Ride',
            type: 'Ride',
            start_date: '2026-06-02T09:00:00Z',
            elapsed_time_min: 45,
            avg_hr: 140,
            max_hr: 170,
            exertion: 3.2,
            url: 'https://www.strava.com/activities/998877'
          }
        ],
        error: null
      }),
      'utf-8'
    )
  });

  await gotoSection(page, 'todo', 'Workouts');
  await expect(page.locator('#stravaFeedList')).toContainText(
    'Browser Import Ride'
  );
});

test('Strava free export CSV can be imported in the browser', async ({
  page
}) => {
  await freezeTime(page, '2026-06-03T12:00:00');
  await seedLocalStorage(page);
  await page.route('**/assets/strava.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ updated_utc: null, activities: [], error: null })
    });
  });

  await page.goto('/');
  await gotoSection(page, 'importExport', 'Import / Export');
  await page.locator('#stravaImportInput').setInputFiles({
    name: 'activities.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Moving Time,Distance,Average Heart Rate,Max Heart Rate,Relative Effort',
        '112233,2026-06-02 09:00:00,Browser CSV Ride,Ride,2700,2500,21.4,140,170,3.2'
      ].join('\n'),
      'utf-8'
    )
  });

  await gotoSection(page, 'todo', 'Workouts');
  await expect(page.locator('#stravaFeedStatus')).toContainText(
    'Imported 1 Strava activities from activities.csv'
  );
  await expect(page.locator('#stravaFeedList')).toContainText(
    'Browser CSV Ride'
  );
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
      }),
      entryFixture({
        id: 'old-alpha-entry',
        projectId: 'alpha',
        description: 'March retrospective',
        startTime: '2026-03-05T09:00:00.000',
        endTime: '2026-03-05T12:00:00.000',
        hours: 3
      })
    ]
  });

  await page.goto('/');
  await gotoSection(page, 'entries', 'Time Entries');

  await expect(page.locator('#toggleEntriesViewBtn')).toHaveText('Show All');
  await expect(page.locator('#entrySummaryPro')).toContainText('2 entries');
  await expect(page.locator('#entrySummaryPro')).toContainText('3h 0m 0s');
  await expect(page.locator('#entrySummaryPro')).toContainText('400.0 kr');
  await expect(page.locator('#entriesTableBodyPro')).not.toContainText(
    'March retrospective'
  );

  await page.locator('#entryDateFromInput').fill('2026-03-01');
  await page.locator('#entryDateToInput').fill('2026-03-31');
  await expect(page.locator('#entrySummaryPro')).toContainText('1 entry');
  await expect(page.locator('#entrySummaryPro')).toContainText(
    'Date range 2026-03-01 - 2026-03-31'
  );
  await expect(page.locator('#entriesTableBodyPro')).toContainText(
    'March retrospective'
  );
  await expect(page.locator('#entriesTableBodyPro')).not.toContainText(
    'Design review'
  );

  await page.locator('#entryDateToInput').fill('');
  await expect(page.locator('#entrySummaryPro')).toContainText(
    'Date range 2026-03-01 - end'
  );
  await expect(page.locator('#entrySummaryPro')).toContainText('3 entries');
  await expect(page.locator('#entriesTableBodyPro')).toContainText(
    'Design review'
  );

  await page.locator('#entryDateClearBtn').click();
  await expect(page.locator('#entrySummaryPro')).toContainText('2 entries');
  await expect(page.locator('#entriesTableBodyPro')).toContainText(
    'Design review'
  );
  await expect(page.locator('#entriesTableBodyPro')).not.toContainText(
    'March retrospective'
  );

  await page.locator('#entryProjectFilter').selectOption('alpha');
  await expect(page.locator('#entrySummaryPro')).toContainText('1 entry');
  await expect(page.locator('#entriesTableBodyPro')).toContainText(
    'Design review'
  );
  await expect(page.locator('#entriesTableBodyPro')).not.toContainText(
    'Admin follow up'
  );

  await page.locator('#entrySearchInput').fill('acme');
  await expect(page.locator('#entriesTableBodyPro')).toContainText(
    'Design review'
  );
  await page.locator('#entrySearchInput').fill('missing');
  await expect(
    page.getByText('No entries match the current filters.')
  ).toBeVisible();
});

test('QoL quick log saved billing views and reminder controls work', async ({
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
        id: 'beta-entry',
        projectId: 'beta',
        description: 'Admin follow up',
        startTime: '2026-04-25T12:00:00.000',
        endTime: '2026-04-25T13:00:00.000',
        hours: 1
      })
    ],
    timerPresets: [
      {
        id: 'alpha-preset',
        projectId: 'alpha',
        description: 'Planning sprint',
        focusFactor: 1.5,
        createdAt: '2026-04-25T09:00:00.000Z',
        updatedAt: '2026-04-25T09:00:00.000Z'
      }
    ]
  });

  await page.goto('/');
  await expect(page.locator('#todayCommandPanel')).toContainText('Today');
  await expect(page.locator('#todayCommandPanel')).toContainText(
    'Quick timers'
  );
  await expect(
    page
      .locator('#todayCommandPanel')
      .getByRole('button', { name: 'Quick Log' })
  ).toHaveCount(0);
  await expect(
    page.locator('#todayCommandPanel').getByRole('button', { name: 'Backup' })
  ).toHaveCount(0);
  await expect(
    page.locator('#todayCommandPanel').getByRole('button', {
      name: 'Alpha Project - Planning sprint - 150%'
    })
  ).toBeVisible();
  await expect(
    page.locator('#todayCommandPanel').getByRole('button', {
      name: 'Beta Project - Admin follow up - 100%'
    })
  ).toBeVisible();
  await page
    .locator('#todayCommandPanel')
    .getByRole('button', {
      name: 'Alpha Project - Planning sprint - 150%'
    })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Timer', exact: true })
  ).toBeVisible();
  await expect(page.locator('[id^="runningFactor-"]').first()).toHaveText(
    '150%'
  );
  await expect(page.locator('#runningTimerPro')).toContainText(
    'Planning sprint'
  );
  await page.getByRole('button', { name: 'Stop All Timers' }).click();

  await gotoSection(page, 'entries', 'Time Entries');
  await page
    .locator('#quickLogInput')
    .fill('1.5h Alpha Project planning yesterday');
  await page.locator('#quickLogForm button[type="submit"]').click();
  await expect(page.locator('#entriesTableBodyPro')).toContainText('planning');

  const quickEntry = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('timekeeperDataPro'));
    return saved.entries.find((entry) => entry.description === 'planning');
  });
  expect(quickEntry.projectId).toBe('alpha');
  expect(quickEntry.duration).toBe(5400);
  expect(quickEntry.endTime).toContain('2026-04-25');

  await page.locator('#entryProjectFilter').selectOption('alpha');
  await page.locator('#saveBillingViewBtn').click();
  const saveDialog = page.getByRole('dialog', { name: 'Save Billing View' });
  await saveDialog.locator('#name').fill('Alpha billing');
  await saveDialog.getByRole('button', { name: 'Save View' }).click();

  await page.locator('#entryProjectFilter').selectOption('beta');
  await expect(page.locator('#entriesTableBodyPro')).toContainText(
    'Admin follow up'
  );
  await page.locator('#billingPresetSelect').selectOption({
    label: 'Alpha billing'
  });
  await expect(page.locator('#entriesTableBodyPro')).toContainText('planning');
  await expect(page.locator('#entriesTableBodyPro')).not.toContainText(
    'Admin follow up'
  );

  await page.locator('#billingPresetSelect').selectOption({
    label: 'This month'
  });
  await expect(page.locator('#entryDateFromInput')).toHaveValue('2026-04-01');
  await expect(page.locator('#entryDateToInput')).toHaveValue('2026-04-30');

  await gotoSection(page, 'importExport', 'Import / Export');
  await expect(page.locator('#pwaStatusPanel')).toContainText('Offline app');
  await expect(page.locator('#reminderStatus')).toContainText(
    'Notification permission'
  );
  await page.locator('#reminderTimerMinutes').fill('180');
  await page.locator('#reminderTimerMinutes').dispatchEvent('change');
  const reminderSettings = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('timekeeperDataPro'));
    return saved.reminderSettings;
  });
  expect(reminderSettings.staleTimerMinutes).toBe(180);
});

test('mobile entries use bottom navigation and card rows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await freezeTime(page, '2026-04-26T12:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'alpha',
        name: 'Alpha Project',
        client: 'Acme'
      })
    ],
    entries: [
      entryFixture({
        id: 'alpha-entry',
        projectId: 'alpha',
        description: 'Mobile card work',
        startTime: '2026-04-25T09:00:00.000',
        endTime: '2026-04-25T10:00:00.000',
        hours: 1
      })
    ]
  });

  await page.goto('/');
  await gotoSection(page, 'entries', 'Time Entries');
  await expect(page.locator('#quickLogInput')).toBeVisible();
  await expect(page.locator('#entriesTableBodyPro')).toContainText(
    'Mobile card work'
  );

  const layout = await page.evaluate(() => {
    const sidebarStyle = getComputedStyle(document.querySelector('.sidebar'));
    const rowStyle = getComputedStyle(
      document.querySelector('#entriesTableBodyPro tr')
    );
    const actionCellStyle = getComputedStyle(
      document.querySelector('#entriesTableBodyPro .entry-actions')
    );
    return {
      sidebarPosition: sidebarStyle.position,
      sidebarBottom: sidebarStyle.bottom,
      rowDisplay: rowStyle.display,
      actionDisplay: actionCellStyle.display,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth
    };
  });

  expect(layout.sidebarPosition).toBe('fixed');
  expect(layout.sidebarBottom).toBe('0px');
  expect(layout.rowDisplay).toBe('block');
  expect(layout.actionDisplay).toBe('flex');
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 2);
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

test('project timer workout and Strava surfaces render markup as inert text', async ({
  page
}) => {
  await freezeTime(page, '2026-04-26T12:00:00');
  await page.addInitScript(() => {
    window['__timekeeperProjectXssFired'] = false;
    window['__timekeeperClientXssFired'] = false;
    window['__timekeeperTimerXssFired'] = false;
    window['__timekeeperWorkoutPresetXssFired'] = false;
    window['__timekeeperWorkoutEntryXssFired'] = false;
    window['__timekeeperStravaXssFired'] = false;
  });
  await page.route('**/assets/strava.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        updated_utc: '2026-04-26T08:00:00Z',
        activities: [
          {
            id: 778899,
            name: '<img src=x onerror="window.__timekeeperStravaXssFired=true">Strava',
            type: 'Ride',
            start_date: '2026-04-26T09:00:00Z',
            elapsed_time_min: 45,
            avg_hr: 140,
            max_hr: 170,
            exertion: 3.2,
            url: 'javascript:window.__timekeeperStravaXssFired=true'
          }
        ],
        error: null
      })
    });
  });
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'unsafe-project',
        name: '<img src=x onerror="window.__timekeeperProjectXssFired=true">Project',
        client:
          '<svg onload="window.__timekeeperClientXssFired=true"></svg>Client'
      })
    ],
    entries: [
      {
        ...entryFixture({
          id: 'unsafe-running-entry',
          projectId: 'unsafe-project',
          description:
            '<img src=x onerror="window.__timekeeperTimerXssFired=true">Timer',
          startTime: '2026-04-26T11:00:00.000',
          createdAt: '2026-04-26T11:00:00.000'
        }),
        endTime: null,
        duration: null,
        isRunning: true,
        effectiveSeconds: 0,
        lastUpdateTime: '2026-04-26T11:00:00.000',
        focusFactor: 1,
        manualFactor: 1
      }
    ],
    workouts: {
      presets: [
        {
          id: 'unsafe-preset',
          name: '<img src=x onerror="window.__timekeeperWorkoutPresetXssFired=true">Preset',
          intensity: 'medium'
        }
      ],
      entries: [
        {
          id: 'unsafe-workout-entry',
          name: '<svg onload="window.__timekeeperWorkoutEntryXssFired=true"></svg>Workout',
          intensity: 'light',
          timestamp: '2026-04-26T09:30:00.000Z',
          presetId: null
        }
      ]
    }
  });

  await page.goto('/');
  await expect(page.locator('#runningTimerPro')).toContainText(
    '<img src=x onerror="window.__timekeeperTimerXssFired=true">Timer'
  );

  await gotoSection(page, 'dashboard', 'Dashboard');
  await expect(page.locator('#detailedBreakdown')).toContainText(
    '<img src=x onerror="window.__timekeeperProjectXssFired=true">Project'
  );
  await expect(page.locator('#detailedBreakdown')).toContainText(
    '<svg onload="window.__timekeeperClientXssFired=true"></svg>Client'
  );

  await gotoSection(page, 'projects', 'Projects');
  await expect(page.locator('#projectsPageList')).toContainText(
    '<img src=x onerror="window.__timekeeperProjectXssFired=true">Project'
  );

  await gotoSection(page, 'todo', 'Workouts');
  await expect(page.locator('#workoutPresetsContent')).toContainText(
    '<img src=x onerror="window.__timekeeperWorkoutPresetXssFired=true">Preset'
  );
  await expect(page.locator('#workoutEntriesContent')).toContainText(
    '<svg onload="window.__timekeeperWorkoutEntryXssFired=true"></svg>Workout'
  );
  await expect(page.locator('#stravaFeedList')).toContainText(
    '<img src=x onerror="window.__timekeeperStravaXssFired=true">Strava'
  );
  await expect(
    page.locator('#stravaFeedList a[href^="javascript:"]')
  ).toHaveCount(0);

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window['__timekeeperProjectXssFired'] ||
            window['__timekeeperClientXssFired'] ||
            window['__timekeeperTimerXssFired'] ||
            window['__timekeeperWorkoutPresetXssFired'] ||
            window['__timekeeperWorkoutEntryXssFired'] ||
            window['__timekeeperStravaXssFired']
        ),
      { timeout: 2000 }
    )
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

test('finance wealth chart stays readable on a mobile viewport', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedLocalStorage(page);
  await page.goto('/');
  await gotoSection(page, 'grocery', 'Finances');

  await expect(page.locator('#wealthChart')).toBeVisible();
  const metrics = await page
    .locator('#wealthDashboardCard')
    .evaluate((card) => {
      const canvas = card.querySelector('#wealthChart');
      return {
        viewportWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        cardClientWidth: card.clientWidth,
        cardScrollWidth: card.scrollWidth,
        canvasWidth: canvas ? canvas.getBoundingClientRect().width : 0,
        canvasHeight: canvas ? canvas.getBoundingClientRect().height : 0
      };
    });

  expect(
    Math.max(metrics.documentScrollWidth, metrics.bodyScrollWidth)
  ).toBeLessThanOrEqual(metrics.viewportWidth + 2);
  expect(metrics.cardScrollWidth).toBeGreaterThan(metrics.cardClientWidth);
  expect(metrics.canvasWidth).toBeGreaterThan(600);
  expect(metrics.canvasHeight).toBeGreaterThan(450);
});

test('weekly workouts include Strava activities from the feed', async ({
  page
}) => {
  await freezeTime(page, '2026-06-03T12:00:00');
  await seedLocalStorage(page);
  await page.route('**/assets/strava.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        updated_utc: '2026-06-03T08:00:00Z',
        activities: [
          {
            id: 18739736076,
            name: 'Lunch Weight Training',
            type: 'WeightTraining',
            start_date: '2026-06-01T09:12:25Z',
            elapsed_time_min: 60.3,
            avg_hr: 147,
            max_hr: 186,
            exertion: 3.8,
            url: 'https://www.strava.com/activities/18739736076'
          }
        ],
        error: null
      })
    });
  });

  await page.goto('/');
  await gotoSection(page, 'todo', 'Workouts');

  const weeklyCard = page.locator('#workoutEntriesContent');
  await expect(weeklyCard).toContainText('This week: 1 workout');
  await expect(weeklyCard).toContainText('Lunch Weight Training');
  await expect(weeklyCard).toContainText('Strava');
  await expect(weeklyCard).not.toContainText('No workouts logged yet');
});

test('Strava feed renders stale activities when refresh reports an error', async ({
  page
}) => {
  await seedLocalStorage(page);
  await page.route('**/assets/strava.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        updated_utc: '2026-06-01T08:00:00Z',
        activities: [
          {
            id: 18739736076,
            name: 'Lunch Weight Training',
            type: 'WeightTraining',
            start_date: '2026-06-01T09:12:25Z',
            elapsed_time_min: 60.3,
            avg_hr: 147,
            max_hr: 186,
            exertion: 3.8,
            url: 'https://www.strava.com/activities/18739736076'
          }
        ],
        error: 'Strava refresh failed'
      })
    });
  });

  await page.goto('/');
  await gotoSection(page, 'todo', 'Workouts');

  await expect(page.locator('#stravaFeedStatus')).toContainText(
    'latest refresh failed'
  );
  await expect(page.locator('#stravaFeedList')).toContainText(
    'Lunch Weight Training'
  );
});

test('Strava feed falls back to browser cache when the published feed is empty', async ({
  page
}) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem(
      'timekeeperStravaFeedCache',
      JSON.stringify({
        updated_utc: '2026-06-01T08:00:00Z',
        cached_utc: '2026-06-03T08:00:00Z',
        activities: [
          {
            id: 18739736076,
            name: 'Cached Weight Training',
            type: 'WeightTraining',
            start_date: '2026-06-01T09:12:25Z',
            elapsed_time_min: 60.3,
            avg_hr: 147,
            max_hr: 186,
            exertion: 3.8,
            url: 'https://www.strava.com/activities/18739736076'
          }
        ]
      })
    );
  });
  await page.route('**/assets/strava.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        updated_utc: '2026-06-03T08:00:00Z',
        activities: [],
        error: 'Strava refresh failed'
      })
    });
  });

  await page.goto('/');
  await gotoSection(page, 'todo', 'Workouts');

  await expect(page.locator('#stravaFeedStatus')).toContainText('Cached');
  await expect(page.locator('#stravaFeedList')).toContainText(
    'Cached Weight Training'
  );
});

test('daily target catches up against the fixed weekly target', async ({
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

  const statsGrid = page.locator('#statsGrid');
  await expect(statsGrid).toContainText('Anders: 0.0 / 6.3h');
  await expect(statsGrid).toContainText('Anders: 2.0 / 8.3h');
  await expect(statsGrid).toContainText('Anders: 52.0 / 41.9h');
});

test('missed Monday hours are spread over the remaining week', async ({
  page
}) => {
  await freezeTime(page, '2026-04-21T10:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'weekly-catchup',
        name: 'Weekly Catchup',
        budgetHours: 35,
        startDate: '2026-04-20',
        deadline: '2026-04-24'
      })
    ],
    entries: [
      entryFixture({
        id: 'monday-shortfall',
        projectId: 'weekly-catchup',
        startTime: '2026-04-20T09:00:00.000',
        endTime: '2026-04-20T12:00:00.000',
        hours: 3
      })
    ]
  });

  await page.goto('/');
  await gotoSection(page, 'dashboard', 'Dashboard');

  const statsGrid = page.locator('#statsGrid');
  await expect(statsGrid).toContainText('Weekly Catchup: 0.0 / 8.0h');
  await expect(statsGrid).toContainText('Weekly Catchup: 3.0 / 35.0h');
});

test('weekend daily target is zero while weekly and rolling targets stay relevant', async ({
  page
}) => {
  await freezeTime(page, '2026-04-25T10:00:00');
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

  const todayCard = page.locator('.stat-card').filter({
    hasText: "Today's Hours"
  });
  const weekCard = page.locator('.stat-card').filter({ hasText: 'This Week' });
  const rollingCard = page
    .locator('.stat-card')
    .filter({ hasText: 'Rolling 30 Days' });
  await expect(todayCard).toContainText('Anders: 0.0 / 0.0h');
  await expect(weekCard).toContainText('Anders: 2.0 / 8.3h');
  await expect(rollingCard).toContainText('Anders: 52.0 / 41.9h');
});

test('timer recommendation uses remaining project hours over workdays left', async ({
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
        id: 'iflai',
        name: 'IFLAI',
        budgetHours: 100,
        startDate: '2026-04-01',
        deadline: '2026-05-31',
        color: '#16a34a'
      }),
      projectFixture({
        id: 'beta',
        name: 'Beta',
        budgetHours: 20,
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
      }),
      entryFixture({
        id: 'iflai-prior-work',
        projectId: 'iflai',
        startTime: '2026-04-10T09:00:00.000',
        endTime: '2026-04-10T11:00:00.000',
        hours: 20
      }),
      {
        ...entryFixture({
          id: 'iflai-codex-today',
          projectId: 'iflai',
          startTime: '2026-04-24T08:00:00.000',
          endTime: '2026-04-24T11:20:00.000',
          hours: 10 / 3
        }),
        source: 'codex'
      }
    ]
  });

  await page.goto('/');

  await expect(page.locator('#timerProjectPro option').first()).toContainText(
    /IFLAI.*Recommended.*needs ~10\.0h today/
  );
  await expect(page.locator('#timerRecommendationPro')).toContainText(
    'Recommended: IFLAI - 10.0h left today'
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

test('new timers use explicit 100 percent focus by default without auto rebalancing', async ({
  page
}) => {
  await freezeTime(page, '2026-04-24T10:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'alpha-project',
        name: 'Alpha Project',
        budgetHours: 8,
        startDate: '2026-04-24',
        deadline: '2026-04-24'
      }),
      projectFixture({
        id: 'beta-project',
        name: 'Beta Project',
        budgetHours: 8,
        startDate: '2026-04-24',
        deadline: '2026-04-24'
      })
    ],
    entries: []
  });

  await page.goto('/');
  await expect(page.locator('#startFactorPro')).toHaveValue('1');
  await expect(page.locator('#startFactorPro')).not.toContainText('Auto');
  await expect(page.locator('#startFactorPro')).not.toContainText('75%');

  await page.locator('#timerProjectPro').selectOption('alpha-project');
  await page.locator('#startTimerBtnPro').click();
  const factors = page.locator('[id^="runningFactor-"]');
  await expect(factors).toHaveCount(1);
  await expect(factors.nth(0)).toHaveText('100%');

  await page.locator('#timerProjectPro').selectOption('beta-project');
  await page.locator('#startTimerBtnPro').click();
  await expect(factors).toHaveCount(2);
  await expect(factors.nth(0)).toHaveText('100%');
  await expect(factors.nth(1)).toHaveText('100%');
  await expect(page.locator('#runningTotalFactor')).toHaveText('200%');
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
        description: 'Review agent output',
        startTime: '2026-04-23T09:00:00.000',
        endTime: '2026-04-23T10:00:00.000',
        createdAt: '2026-04-23T10:00:00.000',
        hours: 1,
        manualFactor: 0.5,
        focusFactor: 0.5
      }),
      {
        ...entryFixture({
          id: 'agent-codex-latest',
          projectId: 'agent-project',
          description: 'Codex: recent imported agent work',
          startTime: '2026-04-24T08:00:00.000',
          endTime: '2026-04-24T09:00:00.000',
          createdAt: '2026-04-24T09:00:00.000',
          hours: 1,
          manualFactor: 0.5,
          focusFactor: 0.5
        }),
        source: 'codex',
        externalId: 'codex-latest'
      },
      {
        ...entryFixture({
          id: 'agent-codex-legacy',
          projectId: 'agent-project',
          description: 'Codex: legacy imported work',
          startTime: '2026-04-24T07:00:00.000',
          endTime: '2026-04-24T08:00:00.000',
          createdAt: '2026-04-24T08:00:00.000',
          hours: 1,
          manualFactor: 0.5,
          focusFactor: 0.5
        }),
        externalId: 'codex-legacy'
      },
      entryFixture({
        id: 'agent-older',
        projectId: 'agent-project',
        description: 'Draft prompt',
        startTime: '2026-04-22T09:00:00.000',
        endTime: '2026-04-22T10:00:00.000',
        createdAt: '2026-04-22T10:00:00.000',
        hours: 1,
        manualFactor: 1,
        focusFactor: 1
      })
    ]
  });

  await page.goto('/');
  await expect(page.locator('#startFactorPro')).toContainText('150%');
  await expect(page.locator('#startFactorPro')).toContainText('200%');
  const recentTimers = page.locator('#recentTimersPro');

  await expect(
    recentTimers.getByRole('button', {
      name: 'Agent Project - Review agent output - 50%'
    })
  ).toBeVisible();
  await expect(
    recentTimers.getByRole('button', {
      name: 'Agent Project - Draft prompt - 100%'
    })
  ).toBeVisible();
  await expect(recentTimers).not.toContainText(
    'Codex: recent imported agent work'
  );
  await expect(recentTimers).not.toContainText('Codex: legacy imported work');

  await page
    .locator('#recentTimersPro')
    .getByRole('button', {
      name: 'Agent Project - Review agent output - 50%'
    })
    .click();

  await expect(page.locator('[id^="runningFactor-"]').first()).toHaveText(
    '50%'
  );
  await expect(page.locator('#runningTimerPro')).toContainText(
    'Review agent output'
  );
});

test('timer presets can be pinned started and unpinned', async ({ page }) => {
  await freezeTime(page, '2026-04-24T10:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'preset-project',
        name: 'Preset Project',
        budgetHours: 8,
        startDate: '2026-04-24',
        deadline: '2026-04-24'
      })
    ],
    entries: []
  });

  await page.goto('/');
  await page.locator('#timerProjectPro').selectOption('preset-project');
  await page.locator('#timerDescriptionPro').fill('Pinned focus pass');
  await page.locator('#startFactorPro').selectOption('1.5');
  await page.getByRole('button', { name: 'Pin Timer' }).click();

  await expect(page.locator('#recentTimersPro')).toContainText('Pinned timers');
  await expect(
    page.getByRole('button', {
      name: 'Preset Project - Pinned focus pass - 150%'
    })
  ).toBeVisible();
  await expect(
    page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('timekeeperDataPro'));
      return data.timerPresets;
    })
  ).resolves.toHaveLength(1);

  await page
    .getByRole('button', {
      name: 'Preset Project - Pinned focus pass - 150%'
    })
    .click();
  await expect(page.locator('[id^="runningFactor-"]').first()).toHaveText(
    '150%'
  );
  await expect(page.locator('#runningTimerPro')).toContainText(
    'Pinned focus pass'
  );

  await page.getByRole('button', { name: 'Stop All Timers' }).click();
  await page.getByRole('button', { name: 'Unpin' }).click();
  await expect(
    page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('timekeeperDataPro'));
      return data.timerPresets || [];
    })
  ).resolves.toHaveLength(0);
});

test('focus blocker sends blocked websites once paid focus exceeds 50 percent', async ({
  page
}) => {
  await freezeTime(page, '2026-04-24T10:00:00');
  await page.addInitScript(() => {
    window['__focusWebhookUrls'] = [];
    window['__focusWindowOpens'] = [];
    const record = (url) => {
      window['__focusWebhookUrls'].push(String(url));
    };
    window.open = (url) => {
      window['__focusWindowOpens'].push(String(url));
      return null;
    };
    window.fetch = (url) => {
      const value = String(url);
      record(value);
      if (value.includes('/focus/status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              active: true,
              blockedSites: ['reddit.com', 'youtube.com']
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }
          )
        );
      }
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
      /\/focus\/start.*paidFocus=150.*blockedSites=.*reddit\.com.*youtube\.com.*music\.youtube\.com.*i\.ytimg\.com/
    );
  await expect
    .poll(async () => page.evaluate(() => window['__focusWindowOpens'] || []))
    .toEqual([]);
  await expandDetails(page.locator('#runningFocusStatus'), 'Desktop blocker');
  await expect(
    page.getByRole('button', { name: 'Check Desktop Blocker' })
  ).toBeVisible();
  await expect(page.locator('#runningFocusStatus')).toContainText(
    'Desktop blocker: active (2 sites)'
  );
});

test('GitHub focus bridge publishes paid focus state without exporting the token', async ({
  page
}) => {
  await freezeTime(page, '2026-04-24T10:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'bridge-project',
        name: 'Bridge Project',
        budgetHours: 8,
        startDate: '2026-04-24',
        deadline: '2026-04-24'
      })
    ],
    entries: []
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'timekeeperFocusBridgeConfig',
      JSON.stringify({
        enabled: true,
        repository: 'nrik-km/nrik-km.github.io',
        branch: 'main',
        path: 'assets/timekeeper-focus-state.json',
        token: 'ghp_test_focus_bridge'
      })
    );
    window['__githubFocusBodies'] = [];
    window.fetch = (url, options = {}) => {
      const value = String(url);
      if (value.includes('api.github.com/repos/nrik-km/nrik-km.github.io')) {
        if ((options.method || 'GET').toUpperCase() === 'PUT') {
          window['__githubFocusBodies'].push(
            JSON.parse(String(options.body || '{}'))
          );
          return Promise.resolve(
            new Response(JSON.stringify({ content: { sha: 'new-sha' } }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'Not Found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          })
        );
      }
      if (value.includes('/focus/status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              active: false,
              blockedSites: []
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }
          )
        );
      }
      return Promise.resolve(new Response('', { status: 204 }));
    };
  });

  await page.goto('/');
  await page.locator('#timerProjectPro').selectOption('bridge-project');
  await page.locator('#startFactorPro').selectOption('1.5');
  await page.locator('#startTimerBtnPro').click();

  await expect
    .poll(async () =>
      page.evaluate(() => (window['__githubFocusBodies'] || []).length)
    )
    .toBeGreaterThan(1);
  const bodies = await page.evaluate(() => window['__githubFocusBodies'] || []);
  const decodedBodies = bodies.map((item) => ({
    body: item,
    state: JSON.parse(Buffer.from(item.content, 'base64').toString('utf8'))
  }));
  const activePublish = decodedBodies.find(
    (item) => item.state.paidFocusPercent === 150
  );
  expect(activePublish).toBeTruthy();
  const body = activePublish.body;
  const focusState = activePublish.state;
  expect(body.message).toContain('Update TimeKeeper focus state');
  expect(body.branch).toBe('main');
  expect(focusState.active).toBe(true);
  expect(focusState.paidFocusPercent).toBe(150);
  expect(focusState.thresholdPercent).toBe(50);
  expect(focusState.blockedSites).toContain('reddit.com');
  await expect(page.locator('#runningFocusStatus')).toContainText(
    'Focus bridge: published'
  );
  await expect
    .poll(async () =>
      page.evaluate(() => localStorage.getItem('timekeeperDataPro') || '')
    )
    .not.toContain('ghp_test_focus_bridge');
});

test('Codex GitHub inbox imports seven recent days once without exporting the token', async ({
  page
}) => {
  await freezeTime(page, '2026-06-13T12:00:00');
  const inboxPayload = {
    version: 1,
    source: 'timekeeper-codex-bridge',
    machineId: 'desktop-a',
    updatedAt: '2026-06-13T10:00:00.000Z',
    records: [
      {
        id: 'codex-today',
        threadId: 'thread-today',
        projectKey: 'VWR-AutoInv',
        timekeeperProjectName: 'IFLAI',
        startTime: '2026-06-13T08:00:00.000Z',
        endTime: '2026-06-13T08:30:00.000Z',
        wallSeconds: 1800,
        focusFactor: 0.5,
        effectiveSeconds: 900,
        description: 'Codex: VWR automation'
      },
      {
        id: 'codex-yesterday',
        threadId: 'thread-yesterday',
        projectKey: 'VWR-AutoInv',
        timekeeperProjectName: 'IFLAI',
        startTime: '2026-06-12T08:00:00.000Z',
        endTime: '2026-06-12T08:30:00.000Z',
        wallSeconds: 1800,
        focusFactor: 0.5,
        effectiveSeconds: 900,
        description: 'Codex: recent work'
      },
      {
        id: 'codex-too-old',
        threadId: 'thread-too-old',
        projectKey: 'VWR-AutoInv',
        timekeeperProjectName: 'IFLAI',
        startTime: '2026-06-06T08:00:00.000Z',
        endTime: '2026-06-06T08:30:00.000Z',
        wallSeconds: 1800,
        focusFactor: 0.5,
        effectiveSeconds: 900,
        description: 'Codex: too old'
      }
    ]
  };
  const encodedInbox = Buffer.from(JSON.stringify(inboxPayload)).toString(
    'base64'
  );
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'iflai',
        name: 'IFLAI',
        budgetHours: 8,
        startDate: '2026-06-13',
        deadline: '2026-06-30'
      })
    ],
    entries: [],
    codexIntegration: {
      enabled: true,
      repository: 'Henrik-KM/TimeKeeper',
      branch: 'main',
      configPath: 'assets/timekeeper-codex-config.json',
      inboxPath: 'assets/timekeeper-codex-inbox',
      importedCodexRecordIds: []
    }
  });
  await page.addInitScript((inboxContent) => {
    localStorage.setItem('timekeeperCodexIntegrationToken', 'ghp_codex_test');
    window.fetch = (url) => {
      const value = String(url);
      if (
        value.includes(
          'api.github.com/repos/Henrik-KM/TimeKeeper/contents/assets/timekeeper-codex-inbox?ref=main'
        )
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                type: 'file',
                name: 'desktop-a.json',
                url: 'https://api.github.com/repos/Henrik-KM/TimeKeeper/contents/assets/timekeeper-codex-inbox/desktop-a.json'
              }
            ]),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }
          )
        );
      }
      if (value.includes('timekeeper-codex-inbox/desktop-a.json')) {
        return Promise.resolve(
          new Response(JSON.stringify({ content: inboxContent }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    };
  }, encodedInbox);

  await page.goto('/');
  await gotoSection(page, 'importExport', 'Import / Export');

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('timekeeperDataPro'));
        return data.entries.length;
      })
    )
    .toBe(2);
  let data = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('timekeeperDataPro'))
  );
  expect(data.entries).toContainEqual(
    expect.objectContaining({
      projectId: 'iflai',
      description: 'Codex: VWR automation',
      duration: 900,
      focusFactor: 0.5,
      manualFactor: 0.5,
      source: 'codex',
      externalId: 'codex-today'
    })
  );
  expect(data.entries).toContainEqual(
    expect.objectContaining({
      projectId: 'iflai',
      description: 'Codex: recent work',
      duration: 900,
      source: 'codex',
      externalId: 'codex-yesterday'
    })
  );
  expect(JSON.stringify(data)).not.toContain('ghp_codex_test');

  await expect(page.getByRole('button', { name: 'Import Now' })).toBeEnabled();
  await page.getByRole('button', { name: 'Import Now' }).click();
  data = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('timekeeperDataPro'))
  );
  expect(data.entries).toHaveLength(2);
  expect(JSON.stringify(data)).not.toContain('codex-too-old');
});

test('Codex config publish retries after a stale GitHub sha', async ({
  page
}) => {
  await freezeTime(page, '2026-06-15T12:00:00');
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'iflai',
        name: 'IFLAI',
        budgetHours: 8,
        startDate: '2026-06-15',
        deadline: '2026-06-30'
      }),
      {
        ...projectFixture({
          id: 'polish',
          name: 'Polish',
          budgetHours: 8,
          startDate: '2026-06-15',
          deadline: '2026-06-30'
        }),
        archived: true
      }
    ],
    entries: [],
    codexIntegration: {
      enabled: true,
      repository: 'Henrik-KM/TimeKeeper',
      branch: 'main',
      configPath: 'assets/timekeeper-codex-config.json',
      inboxPath: 'assets/timekeeper-codex-inbox',
      importedCodexRecordIds: []
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem('timekeeperCodexIntegrationToken', 'ghp_codex_test');
    window['__codexConfigBodies'] = [];
    let configGetCount = 0;
    window.fetch = (url, options = {}) => {
      const value = String(url);
      const method = String(options.method || 'GET').toUpperCase();
      if (
        value.includes(
          'api.github.com/repos/Henrik-KM/TimeKeeper/contents/assets/timekeeper-codex-inbox?ref=main'
        )
      ) {
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        );
      }
      if (
        value.includes(
          'api.github.com/repos/Henrik-KM/TimeKeeper/contents/assets/timekeeper-codex-config.json'
        )
      ) {
        if (method === 'PUT') {
          const body = JSON.parse(String(options.body || '{}'));
          window['__codexConfigBodies'].push(body);
          if (window['__codexConfigBodies'].length === 1) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  message: 'sha does not match',
                  errors: [{ message: 'JSON sha does not match current file' }]
                }),
                {
                  status: 409,
                  headers: { 'Content-Type': 'application/json' }
                }
              )
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify({ content: { sha: 'written-sha' } }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          );
        }
        configGetCount += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              sha: configGetCount === 1 ? 'stale-sha' : 'fresh-sha'
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }
          )
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    };
  });

  await page.goto('/');
  await gotoSection(page, 'importExport', 'Import / Export');
  await page.getByRole('button', { name: 'Publish Config' }).click();

  await expect
    .poll(async () =>
      page.evaluate(() => (window['__codexConfigBodies'] || []).length)
    )
    .toBe(2);
  const bodies = await page.evaluate(() => window['__codexConfigBodies'] || []);
  expect(bodies[0].sha).toBe('stale-sha');
  expect(bodies[1].sha).toBe('fresh-sha');
  const publishedConfig = JSON.parse(
    Buffer.from(bodies[1].content, 'base64').toString('utf8')
  );
  expect(publishedConfig).toMatchObject({
    version: 2,
    matchMode: 'github-parent-folder',
    trackedProjects: [{ name: 'IFLAI', projectId: 'iflai' }]
  });
  expect(JSON.stringify(publishedConfig)).not.toContain('Polish');
  await expect(page.locator('#codexIntegrationStatus')).not.toContainText(
    'error'
  );
  await expect
    .poll(async () =>
      page.evaluate(() => localStorage.getItem('timekeeperDataPro') || '')
    )
    .not.toContain('ghp_codex_test');
});

test('focus blocker can edit blocked websites and resend the active block', async ({
  page
}) => {
  await freezeTime(page, '2026-04-24T10:00:00');
  await page.addInitScript(() => {
    window['__focusWebhookUrls'] = [];
    const record = (url) => {
      window['__focusWebhookUrls'].push(String(url));
    };
    window.fetch = (url) => {
      const value = String(url);
      record(value);
      if (value.includes('/focus/status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              active: true,
              blockedSites: ['example.com', 'music.youtube.com']
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }
          )
        );
      }
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
    .poll(async () =>
      page.evaluate(() =>
        (window['__focusWebhookUrls'] || [])
          .filter((url) => String(url).includes('/focus/start'))
          .join('\n')
      )
    )
    .toContain('reddit.com');

  await expandDetails(page.locator('#runningFocusStatus'), 'Desktop blocker');
  await page.getByRole('button', { name: 'Edit Blocked Sites' }).click();
  const dialog = page.getByRole('dialog', { name: 'Blocked Websites' });
  await expect(dialog).toBeVisible();
  await dialog
    .locator('#blockedSites')
    .fill('https://example.com/path\nmusic.youtube.com\nnot a domain');
  await dialog.getByRole('button', { name: 'Save Sites' }).click();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const starts = (window['__focusWebhookUrls'] || []).filter((url) =>
          String(url).includes('/focus/start')
        );
        return starts.find((url) => String(url).includes('example.com')) || '';
      })
    )
    .toContain('example.com');

  const latestStart = await page.evaluate(() => {
    const starts = (window['__focusWebhookUrls'] || []).filter((url) =>
      String(url).includes('/focus/start')
    );
    return starts[starts.length - 1] || '';
  });
  const parsed = new URL(latestStart);
  expect(parsed.searchParams.get('blockedSites')).toBe(
    'example.com,music.youtube.com'
  );
  expect(parsed.searchParams.get('replaceDefaultSites')).toBe('1');
  const savedSites = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('timekeeperDataPro'));
    return data.focusBlockerSites;
  });
  expect(savedSites).toEqual(['example.com', 'music.youtube.com']);
});

test('focus blocker sends stop when paid focus is zero', async ({ page }) => {
  await freezeTime(page, '2026-04-24T10:00:00');
  await page.addInitScript(() => {
    window['__focusWebhookUrls'] = [];
    window.fetch = (url) => {
      const value = String(url);
      if (value.includes('/focus/')) {
        window['__focusWebhookUrls'].push(value);
      }
      return Promise.resolve(new Response('', { status: 204 }));
    };
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: (url) => {
        const value = String(url);
        if (value.includes('/focus/')) {
          window['__focusWebhookUrls'].push(value);
        }
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

  await expect
    .poll(async () => {
      return page.evaluate(() =>
        (window['__focusWebhookUrls'] || []).join('\n')
      );
    })
    .toMatch(/\/focus\/stop.*paidFocus=0.*threshold=50/);
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
  await expect(page.locator('#verifyBackupBtn')).toBeDisabled();
  await expect(page.locator('#restoreBackupBtn')).toBeDisabled();
  await expect(page.locator('#autoSyncWarning')).toContainText(
    'Auto sync unavailable'
  );
});

test('backup snapshots can be listed and restored from the selected folder', async ({
  page
}) => {
  await page.addInitScript(() => {
    class FakeFileHandle {
      constructor(directory, name) {
        this.kind = 'file';
        this.directory = directory;
        this.name = name;
      }
      async getFile() {
        const content = this.directory.files.get(this.name) || '';
        return new File([content], this.name, {
          type: 'application/json',
          lastModified: Date.now()
        });
      }
      async createWritable() {
        const directory = this.directory;
        const name = this.name;
        const chunks = [];
        return {
          async write(value) {
            chunks.push(String(value));
          },
          async close() {
            directory.files.set(name, chunks.join(''));
          }
        };
      }
    }
    class FakeDirectoryHandle {
      constructor(name) {
        this.kind = 'directory';
        this.name = name;
        this.files = new Map();
        this.directories = new Map();
      }
      async queryPermission() {
        return 'granted';
      }
      async requestPermission() {
        return 'granted';
      }
      async getFileHandle(name, options = {}) {
        if (!this.files.has(name)) {
          if (!options.create) throw new Error(`Missing file ${name}`);
          this.files.set(name, '');
        }
        return new FakeFileHandle(this, name);
      }
      async getDirectoryHandle(name, options = {}) {
        if (!this.directories.has(name)) {
          if (!options.create) throw new Error(`Missing directory ${name}`);
          this.directories.set(name, new FakeDirectoryHandle(name));
        }
        return this.directories.get(name);
      }
      async *entries() {
        for (const [name, directory] of this.directories.entries()) {
          yield [name, directory];
        }
        for (const name of this.files.keys()) {
          yield [name, new FakeFileHandle(this, name)];
        }
      }
      async removeEntry(name) {
        this.files.delete(name);
        this.directories.delete(name);
      }
    }
    // @ts-expect-error Test installs a fake File System Access root.
    window.__timekeeperBackupRoot = new FakeDirectoryHandle('Fake Backup');
    // @ts-expect-error Test installs the browser-only File System Access picker.
    window.showDirectoryPicker = async () => window.__timekeeperBackupRoot;
  });
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'snapshot-project',
        name: 'Snapshot Project'
      })
    ],
    entries: []
  });

  await page.goto('/');
  await gotoSection(page, 'importExport', 'Import / Export');
  await page.getByRole('button', { name: 'Set Backup Folder' }).click();
  await expect(page.locator('#backupSnapshotsPanel')).toContainText(
    '1 snapshot available'
  );
  await expect(page.locator('#backupSnapshotsPanel')).toContainText(
    '1 projects, 0 entries'
  );

  await page.getByRole('button', { name: 'Verify Backup' }).click();
  await expect(page.locator('#backupHealthPanel')).toContainText('Verified');
  await expect(page.locator('#lastBackupStatus')).toContainText('verified');
  const verification = await page.evaluate(() => {
    const root = window['__timekeeperBackupRoot'];
    const data = JSON.parse(localStorage.getItem('timekeeperDataPro'));
    const manifest = JSON.parse(root.files.get('timekeeper-manifest.json'));
    const snapshotDir = root.directories.get('timekeeper-snapshots');
    return {
      verifiedAt: data.lastBackupVerifiedAt,
      latestRevision: JSON.parse(root.files.get('timekeeper-data.json'))
        .backupRevision,
      manifestRevision: manifest.backupRevision,
      snapshotExists: snapshotDir.files.has(manifest.latestSnapshotFile)
    };
  });
  expect(verification.verifiedAt).toMatch(/2026|20/);
  expect(verification.latestRevision).toBe(verification.manifestRevision);
  expect(verification.snapshotExists).toBe(true);

  await gotoSection(page, 'projects', 'Projects');
  await page.locator('#projectNamePro').fill('After Backup');
  await page.locator('#projectBudgetPro').fill('10');
  await page.locator('#projectRatePro').fill('100');
  await page.locator('#projectStartDatePro').fill('2026-04-01');
  await page.locator('#projectDeadlinePro').fill('2026-04-30');
  await page.locator('#projectFormPro button[type="submit"]').click();
  await expect(
    page.getByRole('heading', { name: 'After Backup', exact: true })
  ).toBeVisible();

  await gotoSection(page, 'importExport', 'Import / Export');
  await page.getByRole('button', { name: 'Restore Snapshot' }).first().click();
  await page
    .getByRole('dialog', { name: 'Restore Backup Snapshot' })
    .getByRole('button', { name: 'Restore' })
    .click();

  await gotoSection(page, 'projects', 'Projects');
  await expect(
    page.getByRole('heading', { name: 'Snapshot Project', exact: true })
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'After Backup' })).toHaveCount(
    0
  );
});

test('backup sync pauses before overwriting newer backup data', async ({
  page
}) => {
  await freezeTime(page, '2026-06-03T12:00:00');
  await page.addInitScript(() => {
    class FakeFileHandle {
      constructor(directory, name) {
        this.kind = 'file';
        this.directory = directory;
        this.name = name;
      }
      async getFile() {
        const content = this.directory.files.get(this.name) || '';
        return new File([content], this.name, {
          type: 'application/json',
          lastModified: Date.now()
        });
      }
      async createWritable() {
        const directory = this.directory;
        const name = this.name;
        const chunks = [];
        return {
          async write(value) {
            chunks.push(String(value));
          },
          async close() {
            directory.files.set(name, chunks.join(''));
          }
        };
      }
    }
    class FakeDirectoryHandle {
      constructor(name) {
        this.kind = 'directory';
        this.name = name;
        this.files = new Map();
        this.directories = new Map();
      }
      async queryPermission() {
        return 'granted';
      }
      async requestPermission() {
        return 'granted';
      }
      async getFileHandle(name, options = {}) {
        if (!this.files.has(name)) {
          if (!options.create) throw new Error(`Missing file ${name}`);
          this.files.set(name, '');
        }
        return new FakeFileHandle(this, name);
      }
      async getDirectoryHandle(name, options = {}) {
        if (!this.directories.has(name)) {
          if (!options.create) throw new Error(`Missing directory ${name}`);
          this.directories.set(name, new FakeDirectoryHandle(name));
        }
        return this.directories.get(name);
      }
      async *entries() {
        for (const [name, directory] of this.directories.entries()) {
          yield [name, directory];
        }
        for (const name of this.files.keys()) {
          yield [name, new FakeFileHandle(this, name)];
        }
      }
      async removeEntry(name) {
        this.files.delete(name);
        this.directories.delete(name);
      }
    }

    const remoteBackup = {
      projects: [
        {
          id: 'remote-project',
          name: 'Remote Project',
          client: 'Remote',
          budgetHours: 8,
          hourlyRate: 100,
          startDate: '2026-06-01',
          deadline: '2026-06-30',
          createdAt: '2026-06-01T08:00:00.000Z',
          color: '#2563eb'
        }
      ],
      entries: [],
      backupRevision: 5,
      updatedAt: '2026-06-03T11:00:00.000Z'
    };
    const root = new FakeDirectoryHandle('Conflict Backup');
    root.files.set('timekeeper-data.json', JSON.stringify(remoteBackup));
    root.files.set(
      'timekeeper-manifest.json',
      JSON.stringify({
        app: 'TimeKeeper',
        schemaVersion: 2,
        latestFile: 'timekeeper-data.json',
        writtenAt: '2026-06-03T11:05:00.000Z',
        dataUpdatedAt: '2026-06-03T11:00:00.000Z',
        backupRevision: 5,
        projects: 1,
        entries: 0
      })
    );
    // @ts-expect-error Test installs a fake File System Access root.
    window.__timekeeperBackupRoot = root;
    // @ts-expect-error Test installs the browser-only File System Access picker.
    window.showDirectoryPicker = async () => window.__timekeeperBackupRoot;
  });
  await seedLocalStorage(page, {
    projects: [
      projectFixture({
        id: 'local-project',
        name: 'Local Project'
      })
    ],
    entries: [],
    backupRevision: 2,
    updatedAt: '2026-06-03T09:00:00.000Z'
  });

  await page.goto('/');
  await gotoSection(page, 'importExport', 'Import / Export');
  await page.getByRole('button', { name: 'Set Backup Folder' }).click();

  await expect(page.locator('#autoSyncWarning')).toContainText(
    'Backup folder has newer data'
  );
  await expect(page.locator('#autoSyncToggle')).not.toBeChecked();
  await expect(page.locator('#backupHealthPanel')).toContainText(
    'Newer backup detected'
  );
  await expect(
    page.evaluate(() => {
      const root = window['__timekeeperBackupRoot'];
      return JSON.parse(root.files.get('timekeeper-data.json')).projects[0]
        .name;
    })
  ).resolves.toBe('Remote Project');

  await page.getByRole('button', { name: 'Backup Now' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Overwrite Newer Backup' })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    page.evaluate(() => {
      const root = window['__timekeeperBackupRoot'];
      return JSON.parse(root.files.get('timekeeper-data.json')).projects[0]
        .name;
    })
  ).resolves.toBe('Remote Project');

  await page.getByRole('button', { name: 'Backup Now' }).click();
  await page
    .getByRole('dialog', { name: 'Overwrite Newer Backup' })
    .getByRole('button', { name: 'Overwrite Backup' })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = window['__timekeeperBackupRoot'];
        return JSON.parse(root.files.get('timekeeper-data.json')).projects[0]
          .name;
      })
    )
    .toBe('Local Project');
  await expect(page.locator('#autoSyncWarning')).not.toContainText(
    'Backup folder has newer data'
  );
});

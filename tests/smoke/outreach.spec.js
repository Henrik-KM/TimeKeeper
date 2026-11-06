const { test, expect } = require('@playwright/test');

function snapshot() {
  return {
    schema_version: 1,
    kind: 'henrik_outreach',
    state_version: 'version-1',
    generated_at: new Date().toISOString(),
    next_run_at: new Date(Date.now() + 3600000).toISOString(),
    status: 'running',
    remaining_today: { linkedin: 3, email: 4 },
    counts: {
      messages_sent: 2,
      drafts_prepared: 1,
      interested: 1,
      emails_sent_by_henrik: 0
    },
    opportunities: [
      {
        opportunity_id: 'lead-1',
        person_id: 'person-1',
        company: 'Imaging Partner',
        contact: 'Alex',
        need: 'Requested written evaluation criteria.',
        next_step: 'Review the prepared answer.',
        attention_reason: 'A draft is ready in Outlook.',
        status: 'needs_you',
        channel: 'email',
        source_url: 'https://example.com/criteria'
      },
      {
        opportunity_id: 'lead-2',
        person_id: 'person-2',
        company: 'Screening Partner',
        contact: 'Sam',
        need: 'A documented screening workflow could fit.',
        next_step: 'Send a relevant approved overview.',
        status: 'planned',
        channel: 'linkedin',
        profile_url: 'https://www.linkedin.com/in/sam/'
      },
      {
        opportunity_id: 'lead-3',
        person_id: 'person-3',
        company: 'Interested Partner',
        contact: 'Jo',
        need: 'Requested technical material.',
        next_step: 'Continue with the written answer.',
        status: 'waiting',
        channel: 'linkedin',
        ownership: 'human',
        interest_confirmed: true
      }
    ],
    recent_actions: [
      {
        action_id: 'action-1',
        opportunity_id: 'lead-1',
        channel: 'email',
        status: 'drafted',
        verified_at: new Date().toISOString()
      }
    ]
  };
}
async function connect(page, data = snapshot()) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'timekeeperCompanyOperatorToken',
      'test_private_token'
    );
    localStorage.setItem(
      'timekeeperCompanyOperatorSettings',
      JSON.stringify({
        repository: 'Henrik-KM/timekeeper-private-context',
        branch: 'main'
      })
    );
  });
  const commands = [];
  await page.route(
    'https://api.github.com/repos/Henrik-KM/timekeeper-private-context/contents/**',
    async (route) => {
      const request = route.request();
      if (request.method() === 'PUT') {
        commands.push(
          JSON.parse(
            Buffer.from(request.postDataJSON().content, 'base64').toString(
              'utf8'
            )
          )
        );
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: '{}'
        });
      }
      if (request.url().includes('/outreach/state.json'))
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            content: Buffer.from(JSON.stringify(data)).toString('base64')
          })
        });
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: '{}'
      });
    }
  );
  await page.goto('/#company');
  await expect(
    page.getByRole('heading', { name: 'Outreach', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Imaging Partner', exact: true })
  ).toBeVisible();
  return commands;
}
test('mobile outreach reuses the private connection and shows concrete work', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connect(page);
  await page.screenshot({
    path: test.info().outputPath('outreach-mobile.png'),
    fullPage: true
  });
  await expect(page.locator('#companyPageContent')).toContainText(
    'A draft is ready in Outlook.'
  );
  await page.getByRole('tab', { name: 'Planned (1)' }).click();
  await expect(
    page.getByRole('heading', { name: 'Screening Partner', exact: true })
  ).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search outreach' }).fill('absent');
  await expect(page.locator('#outreach-view')).toContainText(
    'No matching conversations.'
  );
  await page.getByRole('searchbox', { name: 'Search outreach' }).fill('');
  await page.getByRole('tab', { name: 'Active (1)' }).click();
  await expect(page.locator('#outreach-view')).toContainText(
    'You own LinkedIn'
  );
  await expect(page.locator('#outreach-view')).toContainText('Interested');
  await page.getByRole('tab', { name: 'Results (0)' }).click();
  await expect(page.locator('#outreach-view')).toContainText(
    'Prepared Outlook draft'
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
test('outreach queues pause and takeover without claiming immediate application', async ({
  page
}) => {
  const commands = await connect(page);
  await page.screenshot({
    path: test.info().outputPath('outreach-desktop.png'),
    fullPage: true
  });
  await page
    .getByRole('button', { name: 'Pause outreach', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Control queued', exact: true })
  ).toBeDisabled();
  expect(commands[0].action).toBe('pause');
  expect(commands[0].state_version).toBe('version-1');
  await page.getByText('Context and controls', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Take over LinkedIn', exact: true })
    .click();
  expect(commands[1].action).toBe('take_over');
  expect(commands[1].person_id).toBe('person-1');
  await expect(page.locator('#companyPageContent')).toContainText(
    'Control queued for the next run.'
  );
});
test('outreach renders source text inertly and keeps tokens out of saved app data', async ({
  page
}) => {
  const data = snapshot();
  data.opportunities[0].need = '<img src=x onerror="window.outreachXss=true">';
  data.opportunities[0].source_url = 'javascript:alert(1)';
  await connect(page, data);
  await expect(page.locator('#outreach-view img')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Source', exact: true })
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, 'outreachXss'))
  ).toBeUndefined();
  expect(
    await page.evaluate(() => localStorage.getItem('timekeeperDataPro') || '')
  ).not.toContain('test_private_token');
});
test('outreach keeps a cached update when private sync is unavailable', async ({
  page
}) => {
  const data = snapshot();
  await page.addInitScript((value) => {
    localStorage.setItem(
      'timekeeperCompanyOperatorToken',
      'test_private_token'
    );
    localStorage.setItem('timekeeperOutreachSnapshot', JSON.stringify(value));
  }, data);
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({ status: 503, body: '{}' })
  );
  await page.goto('/#company');
  await expect(
    page.getByRole('heading', { name: 'Imaging Partner', exact: true })
  ).toBeVisible();
  await expect(page.locator('#companyPageContent')).toContainText(
    'The private connection needs attention.'
  );
});

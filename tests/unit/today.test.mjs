import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompanyTodayCard,
  chooseTodayAttention
} from '../../src/features/today/core.mjs';

test('Company Today card explains the exact current state', () => {
  const card = buildCompanyTodayCard(
    {
      companySummary: {
        state: 'needs_you',
        headline: 'Choose the Albany delivery route',
        detail: 'Choose direct delivery or partner delivery.',
        deepLink: '#company',
        missionId: 'mission:albany',
        counts: { needsYou: 1 }
      },
      missions: {},
      priorities: []
    },
    { freshness: 'fresh' }
  );

  assert.equal(card.label, 'Company · Needs you');
  assert.equal(card.value, 'Choose the Albany delivery route');
  assert.equal(card.detail, 'Choose direct delivery or partner delivery.');
  assert.equal(card.tone, 'risk');
  assert.equal(card.deepLink, '#company');
});

test('Company Today card keeps project and action readable in the compact grid', () => {
  const card = buildCompanyTodayCard(
    {
      companySummary: {
        state: 'needs_you',
        headline: 'AstraZeneca: Provide the images or review feedback',
        detail: 'The requested material is not in the available sources.'
      },
      missions: {},
      priorities: []
    },
    { freshness: 'fresh' }
  );

  assert.equal(card.value, 'AstraZeneca');
  assert.equal(card.detail, 'Provide the images or review feedback');
  assert.equal(
    card.attentionTitle,
    'AstraZeneca: Provide the images or review feedback'
  );
  assert.equal(
    card.attentionDetail,
    'The requested material is not in the available sources.'
  );
});

test('Company Today card never presents stale information as current', () => {
  const card = buildCompanyTodayCard(
    {
      companySummary: {
        state: 'working',
        headline: 'VWR camera pilot',
        detail: 'Codex is testing the camera configuration.'
      },
      missions: {},
      priorities: []
    },
    { freshness: 'stale' }
  );

  assert.equal(card.tone, 'muted');
  assert.match(card.detail, /Update is stale$/);
});

test('Today shows only the most important active exception', () => {
  const attention = chooseTodayAttention([
    {
      active: true,
      kind: 'finance',
      severity: 'normal',
      urgency: 90,
      title: 'Weekly budget needs a check',
      deepLink: '#grocery'
    },
    {
      active: true,
      kind: 'company',
      severity: 'high',
      urgency: 20,
      title: 'One company decision needs you',
      deepLink: '#company'
    },
    {
      active: false,
      kind: 'timer',
      severity: 'critical',
      urgency: 99,
      title: 'Inactive timer alert'
    }
  ]);

  assert.equal(attention.kind, 'company');
  assert.equal(attention.title, 'One company decision needs you');
  assert.equal(attention.deepLink, '#company');
});

test('Today has a calm Company fallback when nothing is actionable', () => {
  const card = buildCompanyTodayCard(
    {
      companySummary: {
        state: 'clear',
        headline: 'Nothing needs you',
        detail: 'No supported company action is waiting right now.'
      },
      missions: {},
      priorities: []
    },
    { freshness: 'fresh' }
  );

  assert.equal(card.label, 'Company');
  assert.equal(card.value, 'Nothing needs you');
  assert.equal(card.tone, 'muted');
});

test('legacy decision snapshots never pair Needs you with Nothing needs you', () => {
  const card = buildCompanyTodayCard(
    {
      companySummary: {},
      decisions: {
        pendingCount: 1,
        pending: [
          {
            title: 'Choose the pricing direction',
            decisionRequested: 'Choose standard or pilot pricing.',
            why: 'The customer response depends on this choice.'
          }
        ]
      },
      missions: {},
      priorities: []
    },
    { freshness: 'fresh' }
  );

  assert.equal(card.state, 'needs_you');
  assert.equal(card.value, 'Choose standard or pilot pricing.');
  assert.equal(card.detail, 'The customer response depends on this choice.');
  assert.notEqual(card.value, 'Nothing needs you');
});

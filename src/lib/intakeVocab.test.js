// The contract between the form's answer vocabulary and the tier recommendation.
//
// Staff pick these strings in Build; the recommendation keyword-matches them. If a
// label drifts out of the matcher's reach, a proposal goes to a board priced on
// the wrong tier — silently, because an unmatched budget answer just falls through
// to Full-Service. That is what this file is here to stop.
import { describe, it, expect } from 'vitest';
import {
  BUDGET_OPTIONS, TIMELINE_OPTIONS, COMMUNITY_TYPE_OPTIONS,
  MANAGEMENT_STATUS_OPTIONS, ROLE_OPTIONS, withCurrent, isOffList,
} from './intakeVocab.js';
import { budgetIntent, isHighRise, recommendTier } from './proposalTier.js';

// The full truth table. Every budget option the board can pick, the intent it
// resolves to, and the tier a sub-500-home community lands on because of it.
const BUDGET_TRUTH = [
  ['Open — looking for the right fit, not the cheapest', 'open',           'full'],
  ['Cost-sensitive — need a lean option',               'lean',            'financial'],
  ['Tight budget — financial only',                     'financial-only',  'financial'],
  // No keyword matches "Premium — full service expected", so it reads as
  // unstated. Same tier as `open`, weaker `why`. Recorded rather than asserted
  // away: if someone teaches budgetIntent about "premium", this line should
  // change deliberately.
  ['Premium — full service expected',                   'unstated',        'full'],
];

describe('budget vocabulary → tier', () => {
  it('covers every option the form offers', () => {
    expect(BUDGET_TRUTH.map(([label]) => label)).toEqual(BUDGET_OPTIONS);
  });

  BUDGET_TRUTH.forEach(([label, intent, tierId]) => {
    it(`"${label}" → ${intent} → ${tierId}`, () => {
      expect(budgetIntent(label)).toBe(intent);
      expect(recommendTier({ homes: 175, budget: label }).tierId).toBe(tierId);
    });
  });

  it('a blank budget falls through to Full-Service, which is why the flag exists', () => {
    expect(budgetIntent('')).toBe('unstated');
    expect(recommendTier({ homes: 175, budget: '' }).tierId).toBe('full');
  });
});

describe('community type vocabulary', () => {
  it('no current option reaches the on-site branch', () => {
    // Documenting a real gap, not blessing it: the wizard offers no high-rise
    // option, so isHighRise() cannot fire for a wizard lead and on-site is
    // reachable only at 500+ homes. Add 'High-rise' to the form's list (and to
    // COMMUNITY_TYPE_OPTIONS) and this expectation is what will tell you the
    // on-site recommendation just went live.
    COMMUNITY_TYPE_OPTIONS.forEach((t) => expect(isHighRise(t)).toBe(false));
    COMMUNITY_TYPE_OPTIONS.forEach((t) =>
      expect(recommendTier({ homes: 175, metaType: t }).tierId).toBe('full'));
  });

  it('scale still reaches on-site, and outranks the budget answer', () => {
    expect(recommendTier({ homes: 600, metaType: 'Townhomes' }).tierId).toBe('onsite');
    expect(recommendTier({ homes: 600, budget: 'Tight budget — financial only' }).tierId).toBe('onsite');
  });
});

describe('management status vocabulary', () => {
  it('developer-controlled is explained, not just defaulted', () => {
    const rec = recommendTier({ homes: 175, metaStatus: 'New construction / developer-controlled' });
    expect(rec.tierId).toBe('full');
    expect(rec.why).toMatch(/developer/i);
  });

  it('every option produces a recommendation with a stated reason', () => {
    MANAGEMENT_STATUS_OPTIONS.forEach((s) => {
      const rec = recommendTier({ homes: 175, metaStatus: s });
      expect(rec.tierId).toBeTruthy();
      expect(rec.why.length).toBeGreaterThan(10);
    });
  });
});

describe('withCurrent / isOffList', () => {
  it('leaves the canonical list alone when the value is on it', () => {
    expect(withCurrent(BUDGET_OPTIONS, BUDGET_OPTIONS[2])).toBe(BUDGET_OPTIONS);
    expect(withCurrent(TIMELINE_OPTIONS, '')).toBe(TIMELINE_OPTIONS);
    expect(isOffList(TIMELINE_OPTIONS, 'Immediately')).toBe(false);
  });

  it('preserves a value from another intake form rather than blanking it', () => {
    // Real drift: the flat form said "Townhome", the postcard landing page had no
    // type field at all, and the wizard says "Townhomes".
    const opts = withCurrent(COMMUNITY_TYPE_OPTIONS, 'Townhome');
    expect(opts).toContain('Townhome');
    expect(opts).toContain('Townhomes');
    expect(opts.length).toBe(COMMUNITY_TYPE_OPTIONS.length + 1);
    expect(isOffList(COMMUNITY_TYPE_OPTIONS, 'Townhome')).toBe(true);
  });

  it('treats whitespace as empty so it does not manufacture an option', () => {
    expect(withCurrent(ROLE_OPTIONS, '   ')).toBe(ROLE_OPTIONS);
    expect(isOffList(ROLE_OPTIONS, '   ')).toBe(false);
  });
});

// The service answer is now the PRIMARY input to the tier recommendation, and the
// tier sets the price on the board's document. These tests pin the two rules that
// make that safe — highest implied tier wins, and a tier the CAM won't lead with
// is promoted rather than quietly recommended — plus the per-client wiring, so a
// form option added without a map entry fails here instead of doing nothing.
import { describe, it, expect } from 'vitest';
import { tierFromServices, servicesMatched, promote, highestTier } from './proposalServiceTiers.js';
import { recommendTier } from './proposalTier.js';
import { DEFAULT_CAM } from './camProfiles.js';

const ST = DEFAULT_CAM.serviceTiers;                 // CMGT
const rec = (raw) => recommendTier(raw, { serviceTiers: ST });

// Every option CMGT's intake form offers today, plus the on-site one being added.
// Mirrored from the site repo's intake-form.config.js -> PROPOSAL_V2.services.
const FORM_SERVICES = [
  'Full financial management',
  'Vendor coordination',
  'Compliance & insurance',
  'Board meeting support',
  'Resident communication',
  'Collections / delinquency',
  'Reserve planning',
  'After-hours emergency',
  'Maintenance coordination',
  'On-site staff',
];

describe('the CAM map is well-formed', () => {
  it('maps every option the form offers', () => {
    const missing = FORM_SERVICES.filter((s) => !(s in ST.map));
    expect(missing, `unmapped form options: ${missing.join(', ')}`).toEqual([]);
  });

  it('maps every label to a tier on the ladder', () => {
    Object.entries(ST.map).forEach(([label, tier]) => {
      expect(ST.rank, `${label} -> ${tier}`).toContain(tier);
    });
  });

  it('has no label that is a substring of another', () => {
    // Matching is substring-based (labels contain commas and slashes, so the value
    // cannot be split). Overlapping keys would double-match and could silently
    // promote a lead to a higher tier.
    const keys = Object.keys(ST.map).map((k) => k.toLowerCase());
    keys.forEach((a) => keys.forEach((b) => {
      if (a !== b) expect(b.includes(a), `"${a}" is inside "${b}"`).toBe(false);
    }));
  });

  it('has something recommendable at or above every tier it can imply', () => {
    ST.rank.forEach((t) => expect(promote(t, ST)).toBeTruthy());
  });
});

describe('highest implied tier wins', () => {
  it('three financial services plus board meeting support = full service', () => {
    const services = 'Full financial management, Collections / delinquency, Resident communication, Board meeting support';
    expect(tierFromServices(services, ST).impliedTierId).toBe('full');
    expect(rec({ homes: 175, services }).tierId).toBe('full');
  });

  it('anything plus on-site staff = on-site', () => {
    const services = 'Full financial management, Collections / delinquency, On-site staff';
    expect(tierFromServices(services, ST).impliedTierId).toBe('onsite');
    const r = rec({ homes: 175, services });
    expect(r.tierId).toBe('onsite');
    expect(r.why).toMatch(/On-site staff/);
  });

  it('on-site wins even at a small community — it is what they asked for', () => {
    // 24 homes: far below the 500 threshold that used to be the only route to
    // on-site, and exactly the board (Cozy Cove) whose narrative asked for
    // on-site presence three days a week.
    expect(rec({ homes: 24, services: 'On-site staff' }).tierId).toBe('onsite');
  });

  it('scale still reaches on-site with no services ticked, and keeps its own reason', () => {
    const r = rec({ homes: 834, services: '' });
    expect(r.tierId).toBe('onsite');
    expect(r.why).toMatch(/834|500/);
  });

  it('scale is not overruled by a lower service answer', () => {
    const r = rec({ homes: 834, services: 'Full financial management' });
    expect(r.tierId).toBe('onsite');
  });
});

describe("the downsell is never recommended, only offered", () => {
  it('only financial services still opens at Full-Service', () => {
    const r = rec({ homes: 175, services: 'Full financial management' });
    expect(r.tierId).toBe('full');
    expect(r.downsellFrom).toBe('financial');
    expect(r.downsellName).toBe('Financial & Administrative');
  });

  it('the same is true of the budget answer, which used to force financial', () => {
    const r = rec({ homes: 175, budget: 'Tight budget — financial only', services: '' });
    expect(r.tierId).toBe('full');
    expect(r.downsellFrom).toBe('financial');
  });

  it('a full-service answer carries no downsell hint', () => {
    const r = rec({ homes: 175, services: 'Vendor coordination, Board meeting support' });
    expect(r.tierId).toBe('full');
    expect(r.downsellFrom).toBeNull();
  });

  it('a CAM with no policy configured can recommend anything on its ladder', () => {
    const open = { rank: ['financial', 'full'], recommendable: [], map: { 'Books only': 'financial' } };
    expect(recommendTier({ homes: 100, services: 'Books only' }, { serviceTiers: open }).tierId).toBe('financial');
  });
});

describe('no map, no change', () => {
  it('leaves the pre-existing behaviour alone when a CAM has no serviceTiers', () => {
    // Every caller without an account in scope, and the demo boards.
    expect(recommendTier({ homes: 175, budget: 'Tight budget — financial only' }).tierId).toBe('financial');
    expect(recommendTier({ homes: 175, services: 'On-site staff' }).tierId).toBe('full');
    expect(recommendTier({ homes: 175 }).downsellFrom).toBeNull();
  });
});

describe('matching is tolerant of how the value arrives', () => {
  it('reads a comma-joined list without splitting on commas', () => {
    // "Collections / delinquency" and "Compliance & insurance" carry punctuation;
    // the value is one string with the labels joined by ", ".
    const matched = servicesMatched('Compliance & insurance, Collections / delinquency', ST);
    expect(matched).toContain('Compliance & insurance');
    expect(matched).toContain('Collections / delinquency');
  });

  it('survives curly apostrophes, dashes and sloppy whitespace', () => {
    expect(servicesMatched('  ON-SITE   STAFF ', ST)).toContain('On-site staff');
    expect(servicesMatched('on—site staff', ST)).toContain('On-site staff');
  });

  it('still resolves the alias, because leads keep the wording they arrived with', () => {
    // 'On-site support' was the wording before the form shipped 'On-site staff'.
    expect(servicesMatched('On-site support', ST)).toContain('On-site support');
    expect(rec({ homes: 175, services: 'On-site support' }).tierId).toBe('onsite');
  });

  it('returns nothing for an unticked question rather than guessing', () => {
    expect(tierFromServices('', ST)).toBeNull();
    expect(tierFromServices(null, ST)).toBeNull();
    expect(tierFromServices('Something we do not offer', ST)).toBeNull();
  });
});

describe('helpers', () => {
  it('highestTier ignores ids that are not on the ladder', () => {
    expect(highestTier(['full', 'nonsense'], ST.rank)).toBe('full');
    expect(highestTier(['nonsense'], ST.rank)).toBeNull();
  });

  it('promote never demotes', () => {
    expect(promote('onsite', ST)).toBe('onsite');
    expect(promote('full', ST)).toBe('full');
    expect(promote('financial', ST)).toBe('full');
  });
});

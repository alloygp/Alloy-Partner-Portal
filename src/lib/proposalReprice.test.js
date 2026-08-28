import { describe, it, expect } from 'vitest';
import { deriveTierAndPrice } from './proposalReprice.js';
import { DEFAULT_CAM } from './camProfiles.js';

const ST = DEFAULT_CAM.serviceTiers;          // CMGT
const opts = { serviceTiers: ST };

// A lead as stored after a normal intake: Full-Service at the per-home default.
const stored = {
  tierId: 'full', perHome: 8.98, homes: 175,
  budget: '', metaStatus: 'Looking to switch from current provider', metaType: 'Townhomes',
  services: 'Vendor coordination, Board meeting support',
  tierManual: false,
};

describe('the transcript path reprices, which it never used to', () => {
  it('a call revealing on-site moves the tier AND the money', () => {
    // What applyRealign passes when the transcript says the board wants on-site
    // presence. Before this function existed it patched the fact and left
    // tier_id/per_home alone, so the proposal still sent as Full-Service.
    const out = deriveTierAndPrice(stored, { services: 'Vendor coordination, On-site staff' }, opts);
    expect(out.tierId).toBe('onsite');
    expect(out.tierChanged).toBe(true);
    // On-site is a flat fee, so the per-home rate is dropped rather than carried.
    expect(out.perHome).toBe(0);
    expect(out.quoteValue).toBe(2500 * 12);
  });

  it('a call revealing a bigger community crosses the on-site threshold', () => {
    const out = deriveTierAndPrice(stored, { homes: 834 }, opts);
    expect(out.tierId).toBe('onsite');
    expect(out.rec.why).toMatch(/834|500/);
  });

  it('re-derives the annual when only the door count changes', () => {
    const out = deriveTierAndPrice(stored, { homes: 200 }, opts);
    expect(out.tierId).toBe('full');
    expect(out.tierChanged).toBe(false);
    expect(out.quoteValue).toBe(Math.round(8.98 * 200 * 12));
  });
});

describe('a staffer-set rate is not thrown away', () => {
  it('keeps an overridden rate when the tier changes', () => {
    const negotiated = { ...stored, perHome: 11.5 };
    const out = deriveTierAndPrice(negotiated, { budget: 'Cost-sensitive — need a lean option' }, opts);
    // CMGT never opens with Financial, so the tier holds at full…
    expect(out.tierId).toBe('full');
    // …and the agreed rate survives regardless.
    expect(out.perHome).toBe(11.5);
  });

  it('re-bases a rate that is still the outgoing default', () => {
    const out = deriveTierAndPrice(stored, { services: 'On-site staff' }, opts);
    expect(out.perHome).toBe(0);          // on-site default (flat fee)
  });
});

describe('tier_manual: a human choice is not overwritten', () => {
  const manual = { ...stored, tierId: 'financial', perHome: 4.0, tierManual: true };

  it('leaves the tier alone even though the facts point elsewhere', () => {
    const out = deriveTierAndPrice(manual, { homes: 834 }, opts);
    expect(out.tierId).toBe('financial');
    expect(out.manual).toBe(true);
    expect(out.tierChanged).toBe(false);
  });

  it('still reprices the money for the new facts', () => {
    const out = deriveTierAndPrice(manual, { homes: 300 }, opts);
    expect(out.quoteValue).toBe(Math.round(4.0 * 300 * 12));
  });

  it('still reports what the form points at, so staff can be told', () => {
    const out = deriveTierAndPrice(manual, { homes: 834 }, opts);
    expect(out.rec.tierId).toBe('onsite');   // the recommendation, not applied
  });

  it('resumes deriving once the manual flag is cleared', () => {
    const out = deriveTierAndPrice({ ...manual, tierManual: false }, { homes: 834 }, opts);
    expect(out.tierId).toBe('onsite');
  });
});

describe('the downsell survives a reprice', () => {
  it('a financial-only service answer still opens at Full-Service, with the lever noted', () => {
    const out = deriveTierAndPrice(stored, { services: 'Full financial management' }, opts);
    expect(out.tierId).toBe('full');
    expect(out.rec.downsellFrom).toBe('financial');
  });
});

describe('the minimum still applies', () => {
  it('floors a tiny community rather than quoting per-home math', () => {
    const out = deriveTierAndPrice({ ...stored, homes: 12 }, {}, opts);
    // 12 x 8.98 = $107.76 -> the (provisional) $250 floor, annualised.
    expect(out.quoteValue).toBe(250 * 12);
  });

  it('treats a missing door count as no usable count, not as zero revenue', () => {
    const out = deriveTierAndPrice({ ...stored, homes: 0 }, {}, opts);
    expect(out.quoteValue).toBe(250 * 12);
  });
});

// ============================================================================
// The derived consequences of a lead's facts changing: which tier, what rate,
// what annual value.
//
// WHY IT IS ITS OWN MODULE. This logic lived inline in saveDetails ("Edit
// details"), and the OTHER path that changes the same facts — applyRealign, which
// applies what a sales call revealed — did not have it. So the flow the sales
// process actually runs (form → call → paste transcript → build → send) patched
// `budget` and `homes` from the transcript and left tier_id and per_home on
// whatever intake had guessed. A call that established "we only want financials"
// updated the budget field and still sent Full-Service at the per-home default.
// One function, both callers, no third copy to drift.
//
// TIER_MANUAL. Re-derivation exists because a stored tier must not describe facts
// that no longer hold (an 834-home board asking for financial-only sat stored as
// Full-Service, quoting $7,489/mo). But Build now has a tier picker — CMGT's
// Financial & Administrative tier is a downsell that is never recommended and has
// to be reachable by hand — so a stored tier can be a human decision. When it is,
// the tier is left alone and only the money follows the facts. "Stored differs
// from derived" cannot stand in for that: it is also exactly the 834-home
// condition, which is why intent is recorded rather than inferred.
// ============================================================================
import { recommendTier, tierById } from './proposalTier.js';
import { pricing } from './proposalMockData.js';

// The facts the recommendation reads. Anything else about a lead is irrelevant to
// which tier it belongs in, and listing them here keeps a caller from silently
// dropping one (the services answer was dropped for exactly this reason).
const tierFacts = (l) => ({
  homes: Number(l.homes) || 0,
  budget: l.budget,
  metaStatus: l.metaStatus,
  metaType: l.metaType,
  services: l.services,
});

// current: the lead as stored. facts: the edited/revealed values to merge in.
// Returns what to persist and show:
//   tierId, perHome, quoteValue — the derived figures
//   tierChanged                 — for the "tier is now X" confirmation
//   rec                         — the full recommendation (why, downsellFrom…),
//                                 always computed so staff can be told what the
//                                 form points at even when a manual tier stands
export function deriveTierAndPrice(current = {}, facts = {}, { serviceTiers } = {}) {
  const merged = { ...current, ...facts };
  const homes = parseInt(merged.homes, 10) || 0;
  const perHome = Number(merged.perHome) || 0;
  const rec = recommendTier(tierFacts({ ...merged, homes }), { serviceTiers });

  if (merged.tierManual && merged.tierId) {
    // A human owns the tier. The rate and the annual still follow the facts —
    // editing the door count of a manually-set tier must still reprice it.
    const quoteValue = Math.round(pricing({ ...merged, homes, perHome }).monthlyNum * 12);
    return { tierId: merged.tierId, perHome, quoteValue, tierChanged: false, rec, manual: true };
  }

  const tierChanged = rec.tierId !== current.tierId;
  // The RATE is only re-based when it is still the outgoing tier's default, i.e.
  // demonstrably never touched by a staffer. On-site has no per-home rate, so
  // "untouched" there means zero.
  const outgoingDefault = tierById(current.tierId).defaultRate;
  const rateUntouched = outgoingDefault == null ? perHome === 0 : Math.abs(perHome - outgoingDefault) < 1e-9;
  const nextPerHome = tierChanged && rateUntouched ? (rec.perHome != null ? rec.perHome : 0) : perHome;
  const quoteValue = Math.round(pricing({ ...merged, homes, perHome: nextPerHome, tierId: rec.tierId }).monthlyNum * 12);
  return { tierId: rec.tierId, perHome: nextPerHome, quoteValue, tierChanged, rec, manual: false };
}

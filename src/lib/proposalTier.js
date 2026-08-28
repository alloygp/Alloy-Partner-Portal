// ============================================================================
// Which tier the intake form actually points at, and what it contradicts.
//
// The form asks the board a budget question, a management-status question, a unit
// count and which services they want — and none of it reached the recommendation.
// perHome was hardcoded to 8.98 (the Full-Service rate) in proposalIntake, tier_id
// to 'full' in mintLead, and tierName to "Full-Service Management" in enrichLead.
// So a board that ticked "Tight budget — financial only" was quoted Full-Service.
//
// MATCHED AGAINST THE REAL FORM VOCABULARY, read off the live leads table rather
// than guessed:
//   Budget range              Open — looking for the right fit, not the cheapest
//                             Cost-sensitive — need a lean option
//                             Tight budget — financial only
//   Current management status Self-managed by board
//                             Looking to switch from current provider
//                             New construction / developer-controlled
//                             Other
//   Community type            Single-family | Condos
//   Engagement timeline       Immediately | Within 60 days | Engage by Q4 2026 | Just exploring
//   Services needed           multi-select: Full financial management, Vendor
//                             coordination, Compliance & insurance, Board meeting
//                             support, Resident communication, Collections /
//                             delinquency, Reserve planning
//   Number of units           free text — real submissions include "NA" and "1"
//
// This module OWNS the tier catalog (proposalMockData re-exports TIERS from here)
// so there is no import cycle: nothing here imports from proposalMockData.
//
// It recommends and explains; it never prices unilaterally. Staff can override the
// rate in Build, and every recommendation carries a `why` so the number on screen
// is never unattributable.
// ============================================================================

// ---------------------------------------------------------------------------
// The tier catalog. READ THIS BEFORE TRUSTING A NUMBER IN IT.
//
// WHAT IS SOURCED: the rateRange bands ($4.50-$25.00, $2.00-$10.00, and on-site
// as a flat ~$2,500/mo). These sit in src/lib/boardData.js next to unmistakably
// CMGT-specific material (Vantaca portal, the CAM pod, "on-site team payroll
// billed to the HOA as a bi-weekly reimbursement"), so they came from real CMGT
// collateral.
//
// WHAT IS NOT SOURCED: `defaultRate`. boardData.js — the file holding the real
// CMGT tier content — defines NO default rate at all, only the bands. 8.98 and
// 4.00 trace to commit 755f328, in a file headed "Proposal system — MOCK DATA
// (no database)", where the six fabricated demo boards carried FIVE different
// per-home rates (6.75, 7.50, 8.98, 9.00, 9.25). 8.98 was one invented value
// among them that later got reused as "the default Full-Service rate".
//
// So defaultRate is a mid-band PLACEHOLDER, not a CMGT quote. It is in-band and
// therefore plausible, which is exactly why it needs saying out loud: it prices
// EVERY proposal, not just the small ones the minimum catches.
// ---------------------------------------------------------------------------
import { tierFromServices, highestTier, promote } from './proposalServiceTiers.js';

export const DEFAULT_RATE_IS_PROVISIONAL = true;

export const TIERS = [
  { id: 'full', name: 'Full-Service Management', recommended: true, rateRange: '$4.50 – $25.00', defaultRate: 8.98, setupFee: 0 },
  { id: 'financial', name: 'Financial & Administrative', rateRange: '$2.00 – $10.00', defaultRate: 4.0, setupFee: 0 },
  { id: 'onsite', name: 'On-Site Management', rateRange: '≈ $2,500 / month', defaultRate: null, setupFee: 0 },
];

export const tierById = (id) => TIERS.find((t) => t.id === id) || TIERS[0];
export const tierName = (id) => tierById(id).name;

const norm = (s) => String(s || '').toLowerCase().replace(/[‘’`]/g, "'").replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Budget intent. Three real options, two of which mean "not full service".
// ---------------------------------------------------------------------------
export function budgetIntent(budget) {
  const b = norm(budget);
  if (!b) return 'unstated';
  if (/financial only|financial-only/.test(b)) return 'financial-only';   // "Tight budget - financial only"
  if (/cost-sensitive|lean option|\blean\b|tight budget/.test(b)) return 'lean'; // "Cost-sensitive - need a lean option"
  if (/right fit|not the cheapest|\bopen\b/.test(b)) return 'open';       // "Open - looking for the right fit"
  return 'unstated';
}

// On-site is defined by scale: TIERS calls it "For 500+ home communities and
// high-rises", and it is a flat monthly fee, not per-home.
const ONSITE_MIN_HOMES = 500;
// Below this, per-home pricing produces numbers no one would actually contract
// (12 homes x $8.98 = $107.76/mo).
export const PER_HOME_IMPLAUSIBLE_BELOW = 25;

// ---------------------------------------------------------------------------
// MINIMUM MONTHLY FEE — ***PROVISIONAL. NOT CONFIRMED BY CMGT.***
//
// The real floor has to come from the client. These are placeholders so the
// portal stops showing $48/mo.
//
// HOW THEY WERE PICKED, stated honestly: the floor for a tier is what that tier
// costs at PER_HOME_IMPLAUSIBLE_BELOW (25) units at its defaultRate, rounded to
// something a human would say out loud:
//
//   full       25 x $8.98 = $224.50  ->  $250
//   financial  25 x $4.00 = $100.00  ->  $100
//   onsite     already a flat $2,500 (a SOURCED figure), so it is its own floor
//
// That gives a minimum the right SEMANTIC — no community pays less than a
// 25-unit one — but note the input: defaultRate is itself a placeholder (see the
// catalog comment above), so the full and financial floors are a round number
// derived from an unconfirmed rate. They are a stand-in for a client answer, not
// a calculation of one. For reference, the same method against the LOW end of
// the sourced bands would give full 25 x $4.50 = $112.50 and financial
// 25 x $2.00 = $50.
//
// MINIMUM_IS_PROVISIONAL travels with every priced figure so no surface can show
// one of these numbers as though it were agreed. When the real floor arrives:
// change the values here, set MINIMUM_IS_PROVISIONAL = false, done.
// ---------------------------------------------------------------------------
export const MINIMUM_IS_PROVISIONAL = true;
export const TIER_MIN_MONTHLY = { full: 250, financial: 100, onsite: 2500 };
export const tierMinMonthly = (tierId) => TIER_MIN_MONTHLY[tierId] ?? TIER_MIN_MONTHLY.full;

// The ONE place a monthly figure is computed. Returns the number to show plus
// everything a caller needs to be honest about it:
//   monthly     what to charge/show (floored)
//   raw         the unfloored per-home math, for "would have been" copy
//   floored     true when the minimum did the work
//   minimum     which floor applied
//   provisional true when that floor is a placeholder, not client-confirmed
//   effectivePerHome  monthly/homes — what the floor implies per door
export function monthlyFor({ tierId, perHome = 0, homes = 0 } = {}) {
  // No default here on purpose: a MISSING tier must take the same cheap fallback
  // as an unknown one, not quietly become 'full' (the dearest invented floor).
  // Unknown/missing tier: fall back to the CHEAPEST floor, not the dearest. These
  // are invented numbers, so an unrecognised tier must not silently quote $250.
  const id = TIER_MIN_MONTHLY[tierId] != null ? tierId : 'financial';
  const n = Number(homes) || 0;
  const rate = Number(perHome) || 0;
  const minimum = tierMinMonthly(id);
  // Uniform: raw is always the per-home math and Math.max does the work. On-site
  // used to short-circuit raw to the minimum, which made `floored` false — so its
  // equally-invented $2,500 reached the prospect page with no badge and no send
  // gate, AND a staffer who deliberately set a higher rate had it discarded.
  const raw = rate * n;
  const monthly = Math.max(raw, minimum);
  const floored = monthly > raw + 1e-9;
  return {
    monthly,
    raw,
    floored,
    minimum,
    provisional: floored && MINIMUM_IS_PROVISIONAL,
    effectivePerHome: n > 0 ? monthly / n : null,
    tierId: id,
  };
}

export function isHighRise(metaType) {
  return /high.?rise|tower|mid.?rise/.test(norm(metaType));
}

// ---------------------------------------------------------------------------
// The recommendation. Returns the tier, the starting rate, and WHY — the `why`
// is rendered next to the price so the number is always attributable.
// ---------------------------------------------------------------------------
// `opts.serviceTiers` is the CAM's service->tier map (camProfiles.js). Passing it
// makes "Services you're looking for" the PRIMARY signal and enables the CAM's
// downsell policy. Omitting it leaves the pre-existing behaviour exactly as it
// was — the demo/mock paths and every caller without an account in scope.
export function recommendTier(raw = {}, { serviceTiers } = {}) {
  const homes = Number(raw.homes) || 0;
  const intent = budgetIntent(raw.budget);
  const status = norm(raw.metaStatus);
  const highRise = isHighRise(raw.metaType);
  const rank = Array.isArray(serviceTiers?.rank) && serviceTiers.rank.length ? serviceTiers.rank : null;
  const recommendable = rank
    ? (serviceTiers.recommendable && serviceTiers.recommendable.length ? serviceTiers.recommendable : rank)
    : null;
  // What the board ticked. Null when they ticked nothing, or this CAM has no map.
  const svc = tierFromServices(raw.services, serviceTiers);

  let tierId = 'full';
  let why = 'Default for a board that wants the work taken off their plate.';

  // Which branch actually CONCLUDED a tier. The default ('full') is not a
  // conclusion, and treating it as one let it outrank the board's own service
  // answer — so a CAM whose ladder has a recommendable tier below full could
  // never have that tier recommended. `open` and the developer branch only set a
  // reason, never a different tier, so they are not conclusions either.
  let concluded = null;

  // Scale wins: on-site is a staffing model, not a preference.
  if (homes >= ONSITE_MIN_HOMES || highRise) {
    tierId = 'onsite';
    concluded = 'onsite';
    why = highRise && homes < ONSITE_MIN_HOMES
      ? 'High-rise / mid-rise — on-site management is the model for vertical communities.'
      : `${homes.toLocaleString()} homes — on-site management is the model at ${ONSITE_MIN_HOMES}+.`;
  } else if (intent === 'financial-only') {
    tierId = 'financial';
    concluded = 'financial';
    why = 'They asked for financial-only management on the intake form.';
  } else if (intent === 'lean') {
    tierId = 'financial';
    concluded = 'financial';
    why = 'They told us the budget is cost-sensitive and asked for a lean option.';
  } else if (intent === 'open') {
    why = 'They said they are open to the right fit rather than the cheapest.';
  } else if (/developer|new construction/.test(status)) {
    why = 'Developer-controlled setup — full service through homeowner turnover.';
  }

  // ── The service answer, and the CAM's downsell policy ───────────────────
  //
  // Highest tier wins: a board asking for three financial services AND board
  // meeting support is asking for full service, and one asking for on-site is
  // asking for on-site whatever else they ticked. The scale rule above already
  // put on-site in the running, so this is a max() over both signals rather than
  // a precedence chain.
  let downsellFrom = null;
  if (svc && rank) {
    const winner = highestTier(concluded ? [concluded, svc.tierId] : [svc.tierId], rank) || tierId;
    if (winner !== tierId || svc.tierId === tierId) {
      // Only re-word the reason when the services are what decided it; the scale
      // rule's explanation ("834 homes — on-site is the model at 500+") is more
      // informative than a service list when scale is what won.
      if (winner === svc.tierId && !(homes >= ONSITE_MIN_HOMES || highRise)) {
        why = `They asked for ${svc.labels.join(', ')} on the intake form.`;
      }
      tierId = winner;
    }
  }
  if (rank && recommendable) {
    // A tier this CAM does not open with (CMGT: Financial & Administrative is a
    // downsell) is promoted to the lowest recommendable tier at or above it —
    // never demoted, never silently. `downsellFrom` is what staff are told they
    // can drop to; the board is never shown it.
    const promoted = promote(tierId, { rank, recommendable });
    if (promoted && promoted !== tierId) {
      downsellFrom = tierId;
      tierId = promoted;
      why = `${tierById(downsellFrom).name} is not offered up front, so this opens at ${tierById(promoted).name}.`;
    } else if (svc && !recommendable.includes(svc.impliedTierId)
               && rank.indexOf(svc.impliedTierId) >= 0
               && rank.indexOf(svc.impliedTierId) < rank.indexOf(tierId)) {
      // They only asked for things a lower, non-recommendable tier covers, but
      // something else (scale, or the default) already put them higher. Still
      // worth telling staff the lever exists.
      downsellFrom = svc.impliedTierId;
    }
  }

  const tier = tierById(tierId);
  return {
    tierId,
    tierName: tier.name,
    perHome: tier.defaultRate,          // null for on-site (flat fee)
    flatMonthly: tierId === 'onsite' ? 2500 : null,
    rateRange: tier.rateRange,
    budgetIntent: intent,
    why,
    // The tier the answers pointed at that this CAM won't lead with, or null.
    // Staff-facing only — a sales lever, never on the board's document.
    downsellFrom,
    downsellName: downsellFrom ? tierById(downsellFrom).name : null,
    servicesMatched: svc ? svc.matched : [],
  };
}

// ---------------------------------------------------------------------------
// What the form contradicts or leaves unusable. Surfaced to staff BEFORE a
// proposal goes out, because the alternative is a confident document built on a
// contradiction the board itself submitted.
//
// Real example that prompted this: Chappell Creek LOA ticked the frustration
// "Developer-controlled community needing professional setup" while answering
// "Self-managed by board", with 12 units. The matcher was right — it reflected
// the form — but nothing asked which of the two was true.
// ---------------------------------------------------------------------------
export function intakeFlags(raw = {}) {
  const flags = [];
  const pains = raw.selectedPains || [];
  const status = norm(raw.metaStatus);
  const homes = Number(raw.homes) || 0;
  const intent = budgetIntent(raw.budget);
  // What the form points at RIGHT NOW, to compare against what the row stores.
  const rec = recommendTier(raw);

  const saysDeveloper = /developer|new construction/.test(status);
  if (pains.includes('developer') && status && !saysDeveloper) {
    flags.push({
      code: 'developer-vs-status',
      label: 'Developer-controlled, but they say they are not',
      detail: `They ticked the developer-controlled frustration while answering "${raw.metaStatus}". Ask which it is — the proposal's whole transition story depends on it.`,
    });
  }
  if (pains.includes('switching') && /self-managed/.test(status)) {
    flags.push({
      code: 'switching-vs-selfmanaged',
      label: 'Switching providers, but self-managed',
      detail: `They ticked the switching-providers frustration while answering "${raw.metaStatus}". There may be no incumbent to transition from.`,
    });
  }
  if (!homes) {
    // A pick-list band so wide it says nothing is a different problem from a blank
    // or a typo, and it needs a different sentence: the board DID answer, the answer
    // just cannot carry a price.
    const wide = raw.unitsSource === 'wide-band' && Array.isArray(raw.unitsBand);
    flags.push({
      code: 'no-unit-count',
      label: wide ? `"${String(raw.unitsRaw).slice(0, 24)}" is too broad to price` : 'No usable unit count',
      detail: wide
        ? `They picked "${String(raw.unitsRaw).slice(0, 40)}" from a list, which spans ${raw.unitsBand[0]}–${raw.unitsBand[1]} homes. That covers nearly every community size, and the two ends fall under different management models, so no midpoint would be honest. Get the actual door count before quoting.`
        : raw.unitsRaw
          ? `The form sent "${String(raw.unitsRaw).slice(0, 40)}" as the unit count, which is not a number, so per-home pricing cannot be computed. Confirm the door count before quoting.`
          : 'The unit count is missing or not a number, so per-home pricing cannot be computed. Confirm the door count before quoting.',
    });
  } else if (homes < PER_HOME_IMPLAUSIBLE_BELOW) {
    const m = monthlyFor({ tierId: raw.tierId || 'full', perHome: raw.perHome, homes });
    flags.push({
      code: 'tiny-community',
      label: `Only ${homes} ${homes === 1 ? 'unit' : 'units'} — minimum fee applied`,
      detail: m.floored
        ? `Per-home pricing gives $${m.raw.toFixed(2)}/mo at this size, so the $${m.minimum}/mo minimum applies instead. That minimum is a PLACEHOLDER — confirm the real one with CMGT before this goes to a board.`
        : `Small community — check the per-home rate is right at this size.`,
    });
  }
  // A band is not a count. Real forms offer "50-100", "Under 50", "200+ Units"
  // instead of a number, and the door count drives BOTH the tier (on-site at 500+)
  // and the price, so quoting a midpoint as though it were counted is how a board
  // gets a confident number derived from a guess.
  if (homes && raw.unitsApprox) {
    const band = raw.unitsBand;
    const stated = raw.unitsRaw ? `"${String(raw.unitsRaw).slice(0, 30)}"` : 'a range';
    flags.push({
      code: 'unit-count-approximate',
      label: `Unit count is approximate — ${homes.toLocaleString()} assumed`,
      detail: band && band[1]
        ? `They gave ${stated}, so pricing uses the midpoint of ${band[0]}–${band[1]}. Confirm the exact door count before quoting — at this size the tier itself can change.`
        : `They gave ${stated}, which is open-ended, so pricing uses ${homes.toLocaleString()}. Confirm the exact door count before quoting.`,
    });
  }
  if (raw.unitsImplausible) {
    flags.push({
      code: 'unit-count-implausible',
      label: `${homes.toLocaleString()} units looks wrong`,
      detail: `The form sent "${String(raw.unitsRaw || homes).slice(0, 40)}" as the unit count. That is larger than any single community, so it is probably a typo or a portfolio-wide figure. Confirm before quoting.`,
    });
  }
  const budgetFlagged = (intent === 'financial-only' || intent === 'lean') && raw.tierId === 'full';
  if (budgetFlagged) {
    flags.push({
      code: 'tier-vs-budget',
      label: 'Full service against a lean budget',
      detail: `They said "${raw.budget}" but this is set to Full-Service. Deliberate is fine — just make sure the price conversation happens.`,
    });
  }
  // The STORED tier disagreeing with the form at all — not just on budget.
  //
  // tier_id is written once, at mint, from whatever fields had arrived by then, so
  // a row minted before its unit count landed (or edited before saveDetails
  // re-derived the tier) keeps a tier the submission no longer points at, and the
  // price follows the stale tier. Scale is the case the budget flag above misses:
  // an 834-home community stored as Full-Service is quoted per-home when on-site
  // is the model at 500+.
  //
  // Suppressed only when the budget flag already named the SAME destination tier —
  // otherwise a lean-budget row would say the same thing twice. When scale is what
  // overrides (rec = on-site), both flags are true and say different things, so
  // both are shown: the budget flag quotes the board, this one names the tier.
  //
  // This REPORTS rather than corrects: changing a stored price silently is worse
  // than showing that it needs a decision. Edit details re-derives it.
  const budgetSaidTheSame = budgetFlagged && rec.tierId === 'financial';
  if (raw.tierId && raw.tierId !== rec.tierId && !budgetSaidTheSame) {
    flags.push({
      code: 'tier-vs-intake',
      label: `Set to ${tierName(raw.tierId)}, but the form points at ${tierName(rec.tierId)}`,
      detail: `${rec.why} The stored tier drives the price, so this is quoting as ${tierName(raw.tierId)} until it changes. Open Edit details to re-derive it, or leave it if the override is deliberate.`,
    });
  }
  if (!String(raw.budget || '').trim()) {
    flags.push({
      code: 'no-budget',
      label: 'No budget answer',
      detail: 'Nothing to anchor the tier recommendation to, so it defaults to Full-Service.',
    });
  } else if (intent === 'unstated') {
    // They ANSWERED and we could not read it. Previously this was indistinguishable
    // from a matching answer: budgetIntent returned 'unstated', the tier quietly
    // defaulted to Full-Service — the dearest of the three — and no flag fired
    // because raw.budget was non-empty. Silence on the most expensive default is
    // the worst possible behaviour, so say it.
    flags.push({
      code: 'budget-unrecognized',
      label: 'Budget answer not recognised',
      detail: `They answered "${String(raw.budget).slice(0, 45)}", which does not map to any of the known budget options, so the tier fell back to its default rather than being derived. Read it yourself before quoting.`,
    });
  }
  return flags;
}

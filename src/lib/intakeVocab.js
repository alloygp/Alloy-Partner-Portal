// ============================================================================
// The intake form's own answer vocabulary — the exact option strings CMGT's
// proposal wizard offers.
//
// WHY THIS EXISTS. The tier recommendation is keyword matching over free text
// (proposalTier.js → budgetIntent, isHighRise). That is right for INTAKE, where
// the answer arrives as whatever string the form sent. It is wrong for STAFF:
// Build's "Edit details" modal rendered every one of these as an empty text box,
// so correcting a lead's budget meant knowing that the engine looks for
// "financial only" / "lean" / "cost-sensitive". Typing the reasonable-sounding
// "Financial" or "low budget" matched nothing and silently left the tier — and
// therefore the price on the board's document — on Full-Service.
//
// So staff pick from the same list the board saw, and the mapping is pinned by
// intakeVocab.test.js: every option below is asserted to resolve to the tier it
// is supposed to resolve to. Change a label here without changing the matcher and
// the gate fails instead of a proposal quietly going out at the wrong rate.
//
// SOURCE OF TRUTH is the site repo, `src/components/intake-form.config.js` →
// PROPOSAL_V2 (the deployed wizard reads it directly; verified against the live
// bundle on cmgt.org and stg-cmgt.alloygp.co). These are a mirror: the portal
// cannot import across repos. When the form's options change, change them here
// too — the test says what that does to the recommendation.
//
// NOTE for anyone adding a community type: none of the current options match
// isHighRise() (/high.?rise|tower|mid.?rise/), so on-site is reachable only via
// the 500-home threshold. Adding a "High-rise" option to the form would make the
// on-site branch live; that is intended behaviour, and the test states it.
// ============================================================================

// "Budget range" — step 3, OPTIONAL on the form. Two of the four mean
// "not full service" (see budgetIntent).
export const BUDGET_OPTIONS = [
  'Open — looking for the right fit, not the cheapest',
  'Cost-sensitive — need a lean option',
  'Tight budget — financial only',
  'Premium — full service expected',
];

// "Engagement timeline" — step 3, required on the form.
export const TIMELINE_OPTIONS = [
  'Immediately',
  'Within 60 days',
  'Engage by Q3 2026',
  'Engage by Q4 2026',
  'Just exploring',
];

// "Community type" — step 2, required. Feeds isHighRise (and nothing here matches
// it — see the note above).
export const COMMUNITY_TYPE_OPTIONS = [
  'Single-family',
  'Townhomes',
  'Condos',
  'Mixed — townhomes & single-family',
  'Master / mixed-use',
];

// "Current management status" — step 2, required. Feeds the developer-controlled
// branch of the recommendation's `why`.
export const MANAGEMENT_STATUS_OPTIONS = [
  'Self-managed by board',
  'Looking to switch from current provider',
  'New construction / developer-controlled',
  'Other',
];

// "Your role" — step 1, optional.
export const ROLE_OPTIONS = [
  'Board President',
  'Vice President',
  'Treasurer',
  'Secretary',
  'Board Member',
  'Property owner / resident',
  'Other',
];

// A picker's options, guaranteed to be able to represent `current`.
//
// Leads in the pipeline hold values these lists do NOT contain: the postcard
// landing page and the older flat form used their own wording ("Townhome" vs
// "Townhomes", "Self-managed today" vs "Self-managed by board"), and some leads
// carry nothing at all. A plain <select> over the canonical list would show those
// leads as blank and overwrite a real answer with '' on the next save. So an
// off-list value is preserved as its own option, marked so staff can see it came
// from somewhere else.
export function withCurrent(options, current) {
  const v = String(current ?? '').trim();
  if (!v || options.includes(v)) return options;
  return [...options, v];
}

// Is this value off the canonical list (so the UI can say so)?
export const isOffList = (options, current) => {
  const v = String(current ?? '').trim();
  return !!v && !options.includes(v);
};

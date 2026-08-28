// ============================================================================
// Intake mapping — a real WhatConverts lead → the proposal's raw shape.
//
// The CMGT staging form (→ WhatConverts → leads table) submits the board's
// intake. This turns one of those leads into the `proposals` row shape so the
// matcher can run on it exactly like the seeded demo boards.
//
// Frustrations come through as a comma-joined string of the form's labels — and
// those labels CONTAIN commas, so we never split on commas. Instead each canon
// pain is detected by a DISTINCTIVE keyword/regex, which is robust to wording
// drift between the form labels and our canonical PAIN_POINTS labels.
// ============================================================================
import { PAIN_POINTS } from "./proposalMockData.js";
import { recommendTier } from "./proposalTier.js";
import { indexFields, pick, resolveUnits } from "./intakeFields.js";

// pain id → distinctive matcher against the (normalized) frustrations text.
const PAIN_KEYWORDS = {
  communication: /communication/,
  delinquency: /delinquency|collections/,
  "manager-turnover": /manager turnover/,
  transparency: /financial opacity|opacity|own books/,
  reactive: /reactive/,
  switching: /switching providers|worried about disruption/,
  volunteer: /volunteer|burning out|board is burning/,
  compliance: /compliance|fair housing|fiduciary/,
  tech: /tech is dated|no real portal|dated.*(portal|app)/,
  "homeowner-apathy": /homeowner apathy|apathy/,
  "vendor-issues": /vendor/,
  "gulf-south": /gulf south/,
  developer: /developer/,
};
const KNOWN_PAIN_IDS = new Set(PAIN_POINTS.map((p) => p.id));

const norm = (s) => String(s || "").toLowerCase().replace(/[‘’`]/g, "'").replace(/[—–]/g, "-").replace(/\s+/g, " ").trim();

// Frustrations string → array of canonical pain ids (in PAIN_POINTS order).
export function painsFromFrustrations(frustrations) {
  const hay = norm(frustrations);
  if (!hay) return [];
  return PAIN_POINTS.filter((p) => {
    const kw = PAIN_KEYWORDS[p.id];
    return kw && KNOWN_PAIN_IDS.has(p.id) && kw.test(hay);
  }).map((p) => p.id);
}

// A WhatConverts lead (DATA.recentLeads shape: id/name/email/phone/company +
// fields[{name,value}]) → the raw proposal shape enrichLead consumes.
// `opts.serviceTiers` is the CAM's service->tier map (camProfiles.js). With it,
// the board's "Services you're looking for" answer decides the recommended tier;
// without it the pre-existing budget/scale rules apply unchanged.
export function leadToProposalRaw(lead, { serviceTiers } = {}) {
  const f = {};
  (lead.fields || []).forEach((x) => { f[norm(x.name).replace(/\*$/, "").trim()] = x.value; });
  const get = (...keys) => { for (const k of keys) { if (f[norm(k)]) return f[norm(k)]; } return ""; };
  // Logical field resolution, because the form is NOT one fixed form. Exact-name
  // lookup silently returned "" for every variant CMGT's own site and the other
  // intake forms use ("HOA Size", "Type of Association", "CURRENT MANAGEMENT"),
  // which meant homes=0 and a blank type/status feeding the tier. See
  // intakeFields.js for the full list of real names this was measured against.
  const idx = indexFields(lead.fields);
  // Bands, not just integers: "50-100" used to parse as 50,100 homes.
  const units = resolveUnits(idx);
  const budget = pick(idx, "budget").value;
  const metaStatus = pick(idx, "status").value;
  const metaType = pick(idx, "type").value;
  const duesRaw = pick(idx, "dues").value || get("monthly dues / unit", "monthly dues");
  // The form's own answers pick the tier. This used to be hardcoded to the
  // Full-Service rate, so a board asking for "financial only" was quoted
  // full service. Staff can still override the rate in Build.
  const services = pick(idx, "services").value || get("services needed");
  const rec = recommendTier({ homes: units.homes, budget, metaStatus, metaType, services }, { serviceTiers });
  return {
    id: lead.id, // wc_lead_id — becomes the proposal lead_key
    community: lead.company || pick(idx, "community").value || lead.name || "New community",
    contact: lead.name || get("your name", "name") || "",
    contactRole: pick(idx, "role").value || "",
    firstName: (lead.name || get("your name", "name") || "").split(" ")[0] || "there",
    email: lead.email || get("email") || "",
    phone: lead.phone || get("phone") || "",
    city: pick(idx, "location").value || "",
    homes: units.homes,
    // How much to trust that door count. A band resolved to its midpoint must not
    // be presented as a counted number, so this travels with it and intakeFlags
    // turns it into something staff are told before a proposal goes out.
    unitsApprox: units.approx,
    unitsBand: units.band,
    unitsRaw: units.raw || "",
    unitsFrom: units.from || null,
    unitsSource: units.source,
    unitsImplausible: units.implausible,
    metaType,
    metaStatus,
    dues: duesRaw ? `$${String(duesRaw).replace(/[^0-9.]/g, "")} / unit monthly` : "",
    engageTimeline: pick(idx, "timeline").value || "",
    budget,
    // Deliberately from the explicit frustrations question ONLY. Mining the
    // free-text message for pain keywords would put concerns on a board document
    // that the board never actually ticked.
    selectedPains: painsFromFrustrations(pick(idx, "frustrations").value),
    quote: pick(idx, "message").value || lead.message || "",
    received: lead.date ? new Date(lead.date).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "",
    // The machine-readable twin of `received`. `received` is a display string
    // formatted in the browser's locale — useless for computing a lead's age,
    // which is why the inbox used to fall back to the row's insert time.
    receivedAt: lead.date ? new Date(lead.date).toISOString() : null,
    status: "new",
    owner: "",
    // Starting rate for the RECOMMENDED tier (null for on-site, which is a flat
    // monthly fee). Staff adjusts in Build.
    perHome: rec.perHome != null ? rec.perHome : 0,
    tierId: rec.tierId,
    services,
    amenities: get("amenities"),
  };
}

// ============================================================================
// Proposal system — CMGT's proposal CONTENT + the pipeline enrichment layer.
//
// There is NO demo pipeline in here any more. Every lead the cockpit and the
// board document render is a real row from Supabase (`proposals`, drained from
// synced WhatConverts intake); `getLeads()` returns exactly those and nothing
// else. Nothing fabricates a lead, a board, or engagement telemetry — an empty
// pipeline renders as empty.
//
// What DOES live here is CMGT's editorial content (the CAM company facts, team,
// onboarding timeline, what the tier includes, the shared pain taxonomy and its
// per-concern prose) plus `enrichLead`, the ONE path that turns a raw proposal
// row into the shape every proposal surface renders: match → concerns → section
// checklist → pricing → Close telemetry.
//
// Each lead's match (overall %, per-concern fit, concern→UVP links) comes from a
// persisted LLM snapshot when intake matched it, else is computed live by the
// deterministic engine (src/lib/proposalMatch.js) from the board's intake pains.
//
// Per the product decisions: UVPs are per-client and unique; pain points are a
// shared canned list the board selects from (later: custom/open).
// ============================================================================

import { deriveLeadMatch } from "./proposalMatch.js";
import { receivedMs } from "./leadAge.js";
import { tierName as tierNameFor, recommendTier, intakeFlags, monthlyFor } from "./proposalTier.js";
import { ownersFromTeam } from "./proposalOwners.js";
import { DATA } from "../data.js";
// UVPs live in ONE canonical place (the backbone). Re-export so existing
// `import { UVPS, UVP_TITLES, UVP_BLURBS } from proposalMockData` keep working.
import { UVPS } from "./proposalUVPs.js";
export { UVPS, UVP_TITLES, UVP_BLURBS } from "./proposalUVPs.js";

// ---------- The CAM company (CMGT) ----------
export const CAM_COMPANY = {
  name: "CMGT",
  fullName: "Community Management, LLC",
  shortName: "CMGT",
  tagline: "We Manage. You Live.",
  city: "Denham Springs, LA",
  founded: 2007,
  portfolios: 400,
  doors: 60000,
  managers: 91,
  states: 5,
  brand: { primary: "#2b2c6c", deep: "#3D1A52", accent: "#74c275" },
};

export const TEAM = [
  { initials: "JH", name: "Jeff Harman", role: "CEO & Founder", color: "#aed7d0", note: "Founded CMGT in 2007. Built the pod model. Will be on your discovery call." },
  { initials: "AB", name: "Amanda Betancourt", role: "COO", color: "#a1c8e7", note: "Operations and marketing. Personal check-in with every new board at Day 60." },
  { initials: "AM", name: "Ashley Melancon", role: "CFO", color: "#f5d880", note: "Runs the finance function — why your monthly P&L hits by the 20th." },
  { initials: "CT", name: "Chris Tremblay", role: "Chief Real Estate Officer", color: "#d9356e", note: "13 years with CMGT. Now runs developer and vendor relationships." },
];

// 90-day onboarding timeline shown in the board proposal.
export const TIMELINE = [
  { day: "Day 1", t: "Documents handed off", d: "All onboarding documents obtained from your previous management company." },
  { day: "Day 5", t: "Homeowners introduced", d: "Communications sent to all homeowners introducing CMGT." },
  { day: "Day 10", t: "Financials in hand", d: "Financial records and operational information obtained." },
  { day: "Day 15", t: "Credentials secured", d: "Beginning balance checks, homeowner balances confirmed, gate codes, fobs, all credentials." },
  { day: "Day 20", t: "Meet every department", d: "20-day onboarding meeting — all department supervisors attend so the board can ask questions." },
  { day: "Day 30", t: "Go live", d: "Mail & email to homeowners. Contact transfers from the Onboarding Team to your assigned CAM." },
  { day: "Day 45", t: "First site inspection", d: "Inspection complete. Letter to homeowners on findings + quick reference guide created." },
  { day: "Day 60", t: "CEO welcome", d: "CEO sends a personal welcome. COO checks in. Owners can log in and see last month's financials." },
  { day: "Day 90", t: "First violation round", d: "First enforcement round complete. CAM Supervisor follows up at Day 120, then semi-annual." },
];

// What the recommended (Full-Service) tier includes — shown in the proposal.
export const INCLUDES = [
  "Dedicated CAM + full pod (AP, AR, site visits, customer support, ARC)",
  "Assessment collection + in-house collections team",
  "Vendor coordination + maintenance oversight",
  "Annual budget + reserve planning",
  "Insurance claim assistance",
  "Complete financial management + monthly P&L to all homeowners",
  "Board meeting prep, attendance, and minutes",
  "Covenant enforcement with educational-first approach",
  "Vantaca board portal + CMGT mobile app",
];

// Proposal section skeleton (the Build checklist). Required sections lock on;
// one editable section per matched concern, seeded with the concern's prose.
function buildSections(concerns) {
  return [
    { id: "cover", title: "Cover & intro", note: "Greeting + concerns overview", required: true, editable: false, on: true },
    ...concerns.map((c, i) => ({ id: "pain" + i, title: c.label, note: "Pain → answer with metric", required: false, editable: true, on: true, prose: c.body })),
    { id: "built", title: "How this was built", note: "Show the matching reasoning", required: false, editable: false, on: true },
    { id: "pricing", title: "Pricing tiers", note: "Recommended tier + the math", required: true, editable: false, on: true },
    { id: "team", title: "Your team", note: "The humans behind the work", required: false, editable: false, on: true },
    { id: "first90", title: "First 90 days", note: "30/60/90 onboarding plan", required: false, editable: false, on: true },
    { id: "cta", title: "Discovery call CTA", note: "Schedule or reply by email", required: true, editable: false, on: true },
  ];
}

// UVPs are imported from the canonical proposalUVPs.js (re-exported at top of file).

// ---------- Pain-point taxonomy (shared canned list, with matching tags) ----------
export const PAIN_POINTS = [
  { id: "communication", label: "Slow communication — missed calls, no follow-through", tags: ["communication", "responsiveness", "after-hours"] },
  { id: "delinquency", label: "Delinquency creeping up — collections aren't working", tags: ["delinquency", "collections", "financial"] },
  { id: "manager-turnover", label: "Manager turnover — constant relationship rebuilding", tags: ["manager-turnover", "stability", "relationships"] },
  { id: "transparency", label: "Financial opacity — we don't understand our own books", tags: ["transparency", "reporting", "tech", "financial"] },
  { id: "reactive", label: "Reactive management — problems only addressed after escalation", tags: ["responsiveness", "modern"] },
  { id: "switching", label: "Switching providers — worried about disruption", tags: ["switching", "transition", "onboarding"] },
  { id: "volunteer", label: "Volunteer burden — board is burning out", tags: ["communication", "responsiveness", "team-based"] },
  { id: "compliance", label: "Compliance pressure — fair housing, fiduciary, state law", tags: ["compliance", "covenant"] },
  { id: "tech", label: "Tech is dated — no real portal or app", tags: ["tech", "modern", "reporting"] },
  { id: "homeowner-apathy", label: "Homeowner apathy — no one sees the HOA's value", tags: ["transparency", "communication"] },
  { id: "vendor-issues", label: "Vendor management headaches", tags: ["vendor-management", "maintenance"] },
  { id: "gulf-south", label: "Need someone who knows Gulf South realities", tags: ["gulf-south", "regional"] },
  { id: "developer", label: "Developer-controlled community needing professional setup", tags: ["new-community", "developer", "transition"] },
];

// ---------- Pain prose (editorial; LLM rewrites against the board's narrative later) ----------
export const PAIN_PROSE = {
  "communication": { headline: "When you call, a human picks up. And follows through.", body: "You said your current company doesn't return calls. We measure call timeliness — our portfolio average is 97%. The pod model means the people answering your community's calls aren't your CAM scrambling between meetings; they're a support team whose entire job is to listen, route, and follow up.", metric: { value: "97%", label: "Call timeliness rate" } },
  "delinquency": { headline: "Collections start with transparency, not threats.", body: "When homeowners see the financials and understand where their assessments go, they pay. Average delinquency across our portfolio sits at 10%, well below industry. Our in-house team handles late accounts with compassion first.", metric: { value: "10%", label: "Avg portfolio delinquency" } },
  "manager-turnover": { headline: "Your manager isn't carrying the whole job alone.", body: "Managers burn out because they're asked to do everyone else's job too. We're built differently — your CAM is the relationship; specialist departments handle the load. ~91 people supporting ~400 communities. You learn your CAM; your CAM learns your community.", metric: { value: "91", label: "Team members across 5 states" } },
  "transparency": { headline: "Your books, your dashboard, every homeowner — every month.", body: "We were one of the first nationally to send full monthly P&L to every homeowner, not just the board. Financials hit by the 20th, every month. It's written into the management agreement.", metric: { value: "Day 20", label: "Monthly financials delivered" } },
  "reactive": { headline: "We try to solve problems before you know they exist.", body: "Reactive management means firefighting. We're built for the opposite — site visits on a cadence, vendor compliance monitored continuously, insurance and reserves handled by a dedicated department. The board meets to decide, not to chase.", metric: { value: "Daily", label: "Department standups" } },
  "switching": { headline: "Transition handled down to the day.", body: "Switching is the single biggest risk on a board's plate. Our 90-day onboarding is documented by day: docs by Day 1, communications by Day 5, financials by Day 10, credentials by Day 15, a 20-day meeting with every department head, go-live at Day 30. The CEO emails you personally at Day 60.", metric: { value: "90 days", label: "Documented onboarding" } },
  "volunteer": { headline: "We carry the weight your board shouldn't be carrying.", body: "You're volunteers with full-time jobs and lives outside of this. The pod model exists so running a community feels less like a second job. Your CAM holds the relationship; AP processes invoices, AR chases delinquency, site specialists walk the property, support fields homeowner calls. You get your time back.", metric: { value: "1", label: "Primary contact · backed by a pod" } },
  "compliance": { headline: "Covenant enforcement, handled with compassion.", body: "We send an educational letter before the first violation round so homeowners know the rules before they break them. We process violations with the tone of a neighbor, not a court summons. Fair housing, fiduciary, and state law are watched by people whose job is to watch them.", metric: { value: "Educate", label: "First, enforce second" } },
  "tech": { headline: "Software you actually want to log into.", body: "Vantaca powers your board portal, our mobile app, and your homeowner experience. Board members approve ARC requests, pay invoices, and pull documents in one place. 70% of homeowners across our portfolio actually use it, and 56% of payments come through online.", metric: { value: "70%", label: "Active homeowner portal use" } },
  "homeowner-apathy": { headline: "Transparency turns homeowners into participants.", body: "When homeowners can see where their money goes and what it's doing, they start caring. They pay on time. They show up to meetings. Full-membership financial transparency is the lever that fixes the homeowner relationship problem most communities have.", metric: { value: "Monthly", label: "P&L to every homeowner" } },
  "vendor-issues": { headline: "Fewer vendors. Same accountability. In-house option.", body: "Fix-It Squad — our in-house maintenance team — handles common area repairs for communities that want one number to call. For everything else, vendor relationships are managed by a team that knows your community. We get paid by you, and we act like it.", metric: { value: "1", label: "Vendor relationship · one phone line" } },
  "gulf-south": { headline: "Largest in Louisiana. Largest on the Mississippi Gulf Coast.", body: "We've been managing Gulf South communities since 2007. We survived the 2016 Great Flood and came back stronger. We know FEMA zones, hurricane prep, and the regional realities national firms underestimate.", metric: { value: "19 yrs", label: "Gulf South operations" } },
  "developer": { headline: "Developer-to-homeowner handoff, by a team that's done it.", body: "Our Developer Management Program runs new communities from groundbreaking through homeowner board turnover — admin setup, utilities, insurance, banking, the operational handoff. Most communities stay with us once they take control.", metric: { value: "DCM", label: "Dedicated team" } },
};

// ---------- Service tiers ----------
// The catalog lives in proposalTier.js alongside the logic that CHOOSES a tier
// (re-exported here for back-compat). Nothing in proposalTier imports from this
// file, so there is no cycle.
export { TIERS } from "./proposalTier.js";

// Zero-state for a proposal just sent in-session (no opens yet). Sections derive
// from the lead's matched concerns.
export function freshWatch(lead) {
  return {
    heat: "new", opens: 0, lastOpened: "Not opened yet", firstOpened: null,
    sentOn: "Just now", readTime: "—", scrollDepth: 0, expires: "in 30 days", daysLeft: 30, linkLife: 30,
    viewers: [],
    sections: (lead.concerns || []).map((c) => ({ name: c.label, pct: 0, status: "unseen" })),
    feed: [{ when: "Just now", who: "You", event: "Proposal sent · awaiting first open", detail: lead.email, type: "first" }],
  };
}

const fmt = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- Close telemetry aggregation (real board events → WATCH shape) ----------
// The board doc emits open/section/heartbeat/cta events (board-proposal.jsx) to
// the proposal-track edge fn → proposal_events. loadData groups them per proposal
// and hands them here; this rolls them up into the exact shape CloseView renders,
// so Close shows REAL engagement. No events yet → null, and Close renders its
// "not opened yet" zero state rather than inventing opens.
const SECTION_ORDER = ["Cover & intro", "Concerns", "How this was built", "Pricing tiers", "Your team", "First 90 days", "Discovery call CTA"];
const initialsOf = (name) => (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const relTime = (iso) => {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "Yesterday" : `${d}d ago`;
};
const fmtDate = (d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtDateTime = (iso) => `${fmtDate(iso)} · ${new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
const fmtDuration = (ms) => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };

export function aggregateWatch(events, lead) {
  if (!events || !events.length) return null;
  const all = [...events].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  // CURRENT SEND ONLY. A proposal can be sent, demoted, reworked and sent again —
  // proposal_events is append-only across all of that, so counting every event
  // would report the FIRST send's opens as though they came from the latest one
  // ("56 opens" on a proposal nobody has opened since it was re-sent). Anything
  // older than the current sent_at belongs to a previous round.
  //
  // No sent_at (marked sent by hand) → there is no round to scope to, so keep
  // everything; that row renders in the untracked bucket anyway.
  const cutoff = lead.sentAt ? new Date(lead.sentAt).getTime() : null;
  const sorted = cutoff == null ? all : all.filter((e) => new Date(e.created_at).getTime() >= cutoff);
  const priorEvents = all.length - sorted.length;
  const priorOpens = priorEvents ? all.filter((e) => e.event_type === "open").length - sorted.filter((e) => e.event_type === "open").length : 0;
  // Everything from this round was superseded — report the round, not a zero
  // state that looks like the board never engaged at all.
  if (!sorted.length) {
    return {
      heat: "new", opens: 0, response: null,
      lastOpened: "Not opened since this send", firstOpened: null,
      sentOn: fmtDate(lead.sentAt), readTime: "—", scrollDepth: 0,
      expires: fmtDate(new Date(new Date(lead.sentAt).getTime() + 30 * 86400000)),
      daysLeft: Math.max(0, Math.ceil((new Date(lead.sentAt).getTime() + 30 * 86400000 - Date.now()) / 86400000)),
      linkLife: 30, viewers: [], sections: [], feed: [],
      round: { since: lead.sentAt, priorEvents, priorOpens },
    };
  }
  const opens = sorted.filter((e) => e.event_type === "open");

  // Viewers — distinct device, named or "Board member #N" in first-seen order.
  const byViewer = new Map();
  sorted.forEach((e) => {
    if (!byViewer.has(e.viewer_key)) byViewer.set(e.viewer_key, { name: "", opens: 0, last: e.created_at });
    const v = byViewer.get(e.viewer_key);
    if (e.viewer_name) v.name = e.viewer_name;
    if (e.event_type === "open") v.opens += 1;
    v.last = e.created_at;
  });
  let anonN = 0;
  const viewers = [...byViewer.values()].map((v) => {
    const name = v.name || `Board member #${++anonN}`;
    return { initials: initialsOf(name), name, role: "", opens: v.opens, lastSeen: relTime(v.last) };
  });

  // Sections — deepest read pct per section, in document order.
  const secMax = new Map();
  sorted.forEach((e) => { if (e.event_type === "section" && e.section_name) secMax.set(e.section_name, Math.max(secMax.get(e.section_name) || 0, e.pct || 0)); });
  const names = [...SECTION_ORDER, ...[...secMax.keys()].filter((n) => !SECTION_ORDER.includes(n))];
  const sections = names.filter((n) => secMax.has(n)).map((name) => {
    const pct = secMax.get(name) || 0;
    return { name, pct, status: pct >= 80 ? "read" : pct >= 25 ? "skimmed" : "skipped" };
  });

  const scrollDepth = Math.max(0, ...[...secMax.values()], 0);
  const maxMs = Math.max(0, ...sorted.map((e) => e.ms || 0));
  const last = sorted[sorted.length - 1];
  const recentDays = (Date.now() - new Date(last.created_at).getTime()) / 86400000;
  let heat = "new";
  if (opens.length) heat = (opens.length >= 3 && recentDays < 2 && scrollDepth >= 75) ? "hot"
    : (recentDays > 5 || (opens.length <= 1 && scrollDepth < 40)) ? "cold" : "warm";

  const sentAt = lead.sentAt || (opens[0] && opens[0].created_at) || null;
  const linkLife = 30;
  const expiresAt = sentAt ? new Date(new Date(sentAt).getTime() + linkLife * 86400000) : null;
  const daysLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000)) : 0;

  const feed = [...sorted].reverse().filter((e) => e.event_type === "open" || e.event_type === "cta" || (e.event_type === "section" && e.pct >= 80))
    .slice(0, 7).map((e) => ({
      when: relTime(e.created_at),
      who: e.viewer_name || "Board member",
      // cta labels (board responses) are self-descriptive — show them verbatim.
      event: e.event_type === "cta" ? e.section_name : e.event_type === "section" ? `Read ${e.section_name} to ${e.pct}%` : "Opened the proposal",
      type: e.event_type === "cta" ? "cta" : e.event_type === "section" ? "read" : "open",
    }));

  // The board's latest explicit VERDICT (continue / changes / decline), pulled
  // from the cta events' meta — surfaced prominently in Close so staff act on it.
  // 'question' events are voice, not a verdict → excluded here (they still show
  // in the feed above).
  const VERDICT_ACTIONS = ["continue", "changes", "decline"];
  const responses = sorted.filter((e) => e.event_type === "cta" && e.meta && VERDICT_ACTIONS.includes(e.meta.action));
  const r = responses[responses.length - 1];
  const response = r ? { action: r.meta.action, label: r.section_name, meta: r.meta, when: relTime(r.created_at) } : null;

  return {
    heat, opens: opens.length, response,
    // Which send these numbers describe, and how much was left out. The UI tags
    // the panel whenever priorEvents > 0 so nobody reads them as all-time.
    round: { since: sentAt, priorEvents, priorOpens },
    lastOpened: relTime(last.created_at),
    firstOpened: opens.length ? fmtDateTime(opens[0].created_at) : null,
    sentOn: sentAt ? fmtDate(sentAt) : "—",
    readTime: maxMs ? fmtDuration(maxMs) : "—",
    scrollDepth,
    expires: expiresAt ? fmtDate(expiresAt) : "—", daysLeft, linkLife,
    viewers, sections, feed,
  };
}

// Enrich one raw submission into the full pipeline shape: run the matching
// engine (or the match persisted at intake) + attach Close telemetry + build the
// section checklist + pricing-friendly fields. The ONE path every proposal goes
// through (loadData for the cockpit, proposal-board for a magic link), so they
// render identically.
export function enrichLead(s, cam) {
  // Match precedence: the LLM snapshot persisted when intake matched this lead,
  // else the deterministic tag engine. Either way the shape is identical, so the
  // screen is matcher-agnostic. `_source` lets the UI show which one ran.
  //
  // `cam` (a CAM profile from camProfiles.js) white-labels the matcher per
  // account: the UVP set + per-concern prose + includes come from the account's
  // CAM. Omitted → the module defaults (CMGT), so existing callers are unchanged.
  const uvps = cam?.uvps || UVPS;
  const prose = cam?.painProse || PAIN_PROSE;
  const includesList = cam?.includes || INCLUDES;
  const m = s.matchSnapshot || { ...deriveLeadMatch(s.selectedPains, PAIN_POINTS, uvps, { prose, topCaps: 4 }), _source: "engine" };
  // The tier the FORM points at, not a constant. perHome/tier_id are persisted at
  // intake; `tierRec` is recomputed here so an older row (or a hand-edited one)
  // still shows why, and `intakeFlags` surfaces what the submission contradicts.
  const tierRec = recommendTier(s, { serviceTiers: cam?.serviceTiers });
  const tierId = s.tierId || tierRec.tierId;
  const tierName = tierNameFor(tierId);
  // ANNUAL (proposals money is annual; leads money is monthly). Derived through
  // the same floor as the screen, or the two would disagree.
  const quoteValue = s.quoteValue != null
    ? s.quoteValue
    : Math.round(monthlyFor({ tierId, perHome: s.perHome, homes: s.homes }).monthly * 12);
  // Date the board raised these concerns. Derived from the real timestamp rather
  // than splitting `received` on " · " — live intake rows use " at " as the
  // separator, so the old split returned the whole string ("Jul 7, 2026 at 6:47
  // PM") and the tagline read like a log line.
  const firstMs = receivedMs(s);
  const first = firstMs != null
    ? new Date(firstMs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "intake";
  return {
    ...s,
    tierId,
    tierName,
    // The account's real people, for the owner picker and for the name the board
    // document shows a prospect. Prefer what the row carries (the public board
    // gets these from proposal-board — an anonymous prospect has no DATA.team).
    owners: s.owners && s.owners.length ? s.owners : ownersFromTeam(DATA.team),
    tierRec,                                  // { tierId, perHome, why, budgetIntent, … }
    intakeFlags: intakeFlags({ ...s, tierId }), // contradictions to raise before sending
    quoteValue,
    ...m, // match, concerns, scores, links, capsMatched, capsTotal
    // Close engagement: real aggregated board events, or null until a board
    // actually opens the proposal. Never fabricated.
    watch: (s.events && s.events.length) ? aggregateWatch(s.events, s) : null,
    includes: includesList,
    sections: buildSections(m.concerns), // Build checklist skeleton
    gapNote: "There's almost always a small gap worth aligning on — let's talk it through on the discovery call before you sign anything.",
    tagline: `Built around the ${m.concerns.length} concerns ${s.firstName} raised on ${first}.`,
  };
}

// The pipeline the cockpit + board page render: REAL proposals from Supabase
// only (DATA.proposals, enriched in loadData). No fallback — an account with
// nothing in the pipeline renders the empty state, and mock dev without Supabase
// renders the same thing rather than a fictional pipeline.
export function getLeads() {
  return DATA.proposals || [];
}

// pricing helper (per lead, honoring a per-home override).
// Routes through monthlyFor() so the tier's minimum monthly fee applies — a
// 12-home community must not be quoted $48/mo. Carries the floor's provenance
// (`floored`/`provisional`) so callers can say WHY the number is what it is.
export function pricing(lead, perHomeOverride) {
  const perHome = perHomeOverride != null ? perHomeOverride : lead.perHome;
  const m = monthlyFor({ tierId: lead.tierId || 'full', perHome, homes: lead.homes });
  return {
    // On-site is a flat monthly fee, so there is no per-home rate to show.
    // Rendering fmt(0) here put "$0.00" per home on the board document.
    perHome: m.tierId === 'onsite' ? '—' : fmt(perHome),
    flat: m.tierId === 'onsite',
    monthly: fmt(m.monthly),
    annual: fmt(m.monthly * 12),
    monthlyNum: m.monthly,
    rawMonthly: fmt(m.raw),
    floored: m.floored,
    provisional: m.provisional,
    minimum: m.minimum,
    effectivePerHome: m.effectivePerHome != null ? fmt(m.effectivePerHome) : null,
  };
}

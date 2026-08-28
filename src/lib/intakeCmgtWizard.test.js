// ============================================================================
// The LIVE CMGT intake wizard, mapped end to end.
//
// Field names and option values below are lifted verbatim from the deployed
// wizard bundle on stg-cmgt.alloygp.co (Astro island `IntakeForm`, step set for
// intent=proposal). intakeFields.js was written against the field names found in
// the leads table; this pins the OTHER end — the form that is actually feeding
// the CMGT pilot — so a copy change on the site that breaks the door count, the
// tier, or the board's concerns fails here instead of on a board document.
//
// It also guards the path that produced a hung "Matching engine · Working"
// overlay: a throw anywhere in leadToProposalRaw → enrichLead escapes into the
// auto-drain's empty catch, so the scrim stays up and the lead never renders.
// ============================================================================
import { describe, it, expect } from "vitest";
import { leadToProposalRaw, painsFromFrustrations } from "./proposalIntake.js";
import { enrichLead, PAIN_POINTS } from "./proposalMockData.js";
import { DEFAULT_CAM } from "./camProfiles.js";

// Every frustration the wizard offers, verbatim (em dashes and curly apostrophes
// included — they are what the form submits).
const FRUSTRATIONS = [
  "Slow communication — missed calls, no follow-through",
  "Delinquency creeping up — collections aren’t working",
  "Manager turnover — constant relationship rebuilding",
  "Financial opacity — we don’t see our own books",
  "Reactive maintenance — problems only addressed after escalation",
  "Switching providers — worried about disruption",
  "Volunteer burden — board is burning out",
  "Compliance pressure — fair housing, fiduciary, state law",
  "Tech is dated — no real portal or app",
  "Homeowner apathy — no one sees the HOA’s value",
  "Vendor management headaches",
  "Need someone who knows Gulf South realities",
  "Developer-controlled community needing professional setup",
];

const COMMUNITY_TYPES = [
  "Single-family HOA", "Condominium", "Townhome",
  "Master-planned", "Developer-controlled", "Commercial / mixed-use",
];
const STATUSES = [
  "Self-managed by board", "Looking to switch from current provider",
  "New construction / developer-controlled", "Other",
];
const TIMELINES = ["Immediately", "Within 60 days", "Engage by Q3 2026", "Engage by Q4 2026", "Just exploring"];
const BUDGETS = [
  "Open — looking for the right fit, not the cheapest",
  "Cost-sensitive — need a lean option",
  "Tight budget — financial only",
  "Premium — full service expected",
];

// A WhatConverts lead as the sync stores it: fields are [{name, value}] pairs
// carrying the form's own labels.
function wcLead(overrides = {}, fieldOverrides = {}) {
  const fields = {
    "Association / community name": "Happy Hills",
    "Location": "Baton Rouge, LA",
    "Number of units": "120",
    "Community type": "Single-family HOA",
    "Current management status": "Looking to switch from current provider",
    "Monthly dues / unit": "$185",
    "Amenities": "Community pool, Clubhouse, Gated entry",
    "Services needed": "Full financial management, Collections / delinquency",
    "Frustrations": FRUSTRATIONS.slice(0, 3).join(", "),
    "Budget range": "Open — looking for the right fit, not the cheapest",
    "Engagement timeline": "Immediately",
    "Role": "Board President",
    "Anything else?": "We are three months from our contract ending and need a clean transition.",
    ...fieldOverrides,
  };
  return {
    id: "wc-991",
    name: "Dana Reed",
    email: "dana@example.com",
    phone: "225-555-0140",
    company: "Happy Hills",
    date: "2026-08-28T15:40:00.000Z",
    fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
    ...overrides,
  };
}

describe("CMGT intake wizard → proposal", () => {
  it("maps the wizard's fields onto the proposal shape", () => {
    const raw = leadToProposalRaw(wcLead());

    expect(raw.community).toBe("Happy Hills");
    expect(raw.contact).toBe("Dana Reed");
    expect(raw.firstName).toBe("Dana");
    expect(raw.email).toBe("dana@example.com");
    expect(raw.contactRole).toBe("Board President");
    expect(raw.city).toBe("Baton Rouge, LA");
    // A counted number, so it must NOT be flagged approximate.
    expect(raw.homes).toBe(120);
    expect(raw.unitsApprox).toBe(false);
    expect(raw.metaType).toBe("Single-family HOA");
    expect(raw.metaStatus).toBe("Looking to switch from current provider");
    expect(raw.dues).toBe("$185 / unit monthly");
    expect(raw.engageTimeline).toBe("Immediately");
    // The narrative the matcher runs on — "Anything else?" is the wizard's
    // message box, and an empty quote means the LLM matches on nothing.
    expect(raw.quote).toMatch(/contract ending/);
    expect(raw.receivedAt).toBe("2026-08-28T15:40:00.000Z");
    expect(raw.tierId).toBeTruthy();
  });

  it("resolves every frustration the wizard offers to a real pain point", () => {
    const known = new Set(PAIN_POINTS.map((p) => p.id));
    for (const label of FRUSTRATIONS) {
      const ids = painsFromFrustrations(label);
      expect(ids.length, `no pain matched: ${label}`).toBeGreaterThan(0);
      ids.forEach((id) => expect(known.has(id), `unknown pain id ${id}`).toBe(true));
    }
    // All thirteen ticked at once resolves to thirteen distinct concerns —
    // the labels contain commas, so this is also the guard against splitting on them.
    const all = painsFromFrustrations(FRUSTRATIONS.join(", "));
    expect(new Set(all).size).toBe(FRUSTRATIONS.length);
  });

  it("survives every option combination without throwing, through enrichLead", () => {
    // enrichLead is what the auto-drain calls after the match; a throw here is a
    // stuck overlay and a lead that never appears.
    for (const metaType of COMMUNITY_TYPES) {
      for (const metaStatus of STATUSES) {
        for (const budget of BUDGETS) {
          for (const timeline of TIMELINES) {
            const raw = leadToProposalRaw(wcLead({}, {
              "Community type": metaType,
              "Current management status": metaStatus,
              "Budget range": budget,
              "Engagement timeline": timeline,
            }));
            const out = enrichLead(raw);
            expect(out.tierId).toBeTruthy();
            expect(out.tierName).toBeTruthy();
            expect(Array.isArray(out.concerns)).toBe(true);
            expect(Array.isArray(out.sections)).toBe(true);
            expect(Number.isFinite(out.quoteValue)).toBe(true);
          }
        }
      }
    }
  });

  it("survives a nearly empty submission (only the required contact step)", () => {
    const bare = {
      id: "wc-992", name: "Sam Fox", email: "sam@example.com", phone: "", company: "",
      date: "2026-08-28T15:40:00.000Z",
      fields: [{ name: "Association / community name", value: "Cedar Run" }],
    };
    const raw = leadToProposalRaw(bare);
    expect(raw.community).toBe("Cedar Run");
    expect(raw.homes).toBe(0);
    expect(raw.selectedPains).toEqual([]);
    const out = enrichLead(raw);
    expect(out.tierId).toBeTruthy();
    expect(Array.isArray(out.concerns)).toBe(true);
  });

  it("the services answer drives the tier, end to end from the form field", () => {
    // The whole chain: WhatConverts field named "Services needed" -> intakeFields
    // resolution -> raw.services -> the CAM's map -> the recommendation.
    const st = DEFAULT_CAM.serviceTiers;
    const onsite = leadToProposalRaw(
      wcLead({}, { "Services needed": "Full financial management, On-site staff" }),
      { serviceTiers: st },
    );
    expect(onsite.services).toMatch(/On-site staff/);
    expect(onsite.tierId).toBe("onsite");

    // Only financial services: CMGT never opens with the downsell.
    const financialOnly = leadToProposalRaw(
      wcLead({}, { "Services needed": "Full financial management" }),
      { serviceTiers: st },
    );
    expect(financialOnly.tierId).toBe("full");

    // And without a CAM map, nothing about the old behaviour changes.
    expect(leadToProposalRaw(wcLead({}, { "Services needed": "On-site staff" })).tierId).toBe("full");
  });

  it("handles a lead with no fields at all without throwing", () => {
    const raw = leadToProposalRaw({ id: "wc-993", name: "", email: "", company: "", fields: [] });
    expect(raw.community).toBe("New community");
    expect(() => enrichLead(raw)).not.toThrow();
  });
});

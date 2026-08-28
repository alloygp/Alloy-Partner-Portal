import { supabase } from './supabase.js';
import { enrichLead } from './proposalMockData.js';
import { camFor } from './camProfiles.js';
import { isPlanningItem } from './quarterStats.js';

// A proposals row (snake_case DB) → the raw lead shape enrichLead consumes
// (camelCase) that enrichLead consumes. Shared by loadData and the
// board route's standalone fetch so the mapping never drifts.
export function proposalRowToRaw(p) {
  return {
    id: p.lead_key,
    accountId: p.account_id, // which CAM this proposal belongs to (white-label lookup)
    community: p.community, contact: p.contact, contactRole: p.contact_role, firstName: p.first_name,
    city: p.city, homes: p.homes, status: p.status, priority: p.priority, owner: p.owner,
    perHome: Number(p.per_home) || 0, received: p.received,
    email: p.email, phone: p.phone, metaType: p.meta_type, metaStatus: p.meta_status,
    dues: p.dues, engageTimeline: p.engage_timeline, budget: p.budget,
    selectedPains: p.selected_pains || [], quote: p.quote,
    disq: p.disq, disqReason: p.disq_reason, linkExpires: p.link_expires,
    quoteValue: p.quote_value != null ? p.quote_value : undefined,
    salesValue: p.sales_value != null ? p.sales_value : undefined,
    tierId: p.tier_id, notes: p.notes || [], _dbId: p.id,
    // The board's service answer (primary tier signal) and whether a human set
    // the tier by hand. Both must survive a reload or every later edit re-derives
    // without the signal that produced the current tier.
    services: p.services || '', tierManual: !!p.tier_manual, amenities: p.amenities || '',
    boardToken: p.board_token, sentAt: p.sent_at || null,
    // receivedAt = when the board actually submitted the intake form (the real
    // age of the lead). arrivedAt = when a sync minted this row, which can be
    // weeks later on a backlog pull — kept only as leadAge.js's last-resort
    // fallback, never as the displayed age.
    receivedAt: p.received_at || null,
    arrivedAt: p.created_at || null,
    openedAt: p.opened_at || null, openedBy: p.opened_by || null, // null → "new"; set → "reviewed"
    matchSnapshot: p.match_snapshot || null, // persisted LLM match (preferred by enrichLead)
    boardResponse: p.board_response || null, // the board's verdict {action, by, at} (forward-only)
  };
}

// Static UI config (not account data) — mirrors the mock's DATA.roles.
const ROLES = [
  { id: 'owner', label: 'Owner' },
  { id: 'bd', label: 'BD' },
  { id: 'ops', label: 'Ops' },
];

// Humanized "due" label computed fresh from the real date so it never goes stale.
export function relativeDue(dateStr) {
  if (!dateStr) return '';
  const due = new Date(`${dateStr}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  if (days === 0) return 'due today';
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days < 14) return `in ${days} days`;
  return `in ${Math.ceil(days / 7)} wks`;
}

// "8 months in" / "2 years in" — a market's age from its onboarded date.
export function monthsSinceLabel(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  const now = new Date();
  const months = Math.max(0, (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth()));
  if (months < 1) return 'Just launched';
  if (months < 12) return `${months} months in`;
  const years = Math.floor(months / 12);
  return years === 1 ? '1 year in' : `${years} years in`;
}

/**
 * Lightweight "who am I": is this a staff member, and (for clients) which
 * account are they locked to. Drives the staff-vs-client branch in AuthGate.
 */
export async function getMe(session) {
  const { data, error } = await supabase
    .from('profiles').select('account_id, is_staff, name, initials, avatar_url, role, tour_completed_at, notification_prefs')
    .eq('id', session.user.id).maybeSingle();
  if (error) throw error;
  if (!data) return null; // signed in but no profile → no access
  return {
    accountId: data.account_id || null,
    isStaff: !!data.is_staff,
    profile: data,
  };
}

/**
 * Fetches every table for a given account and reshapes them into the exact
 * object shape the UI expects from the old mock `DATA`. `accountId` is the
 * account being viewed — a client's own, or any client for staff (RLS allows
 * staff to read all). `me` is the signed-in profile (for DATA.user).
 */
export async function loadAccountData(session, accountId, me) {
  if (!accountId) return null;

  const [
    accountRes, recurringRes, projectsRes, leadsRes,
    activityRes, ticketsRes, kpisRes, roiRes, libraryRes,
    badgesRes, snapCurRes, snapPastRes, roadmapRes, actionRes, invoicesRes, teamRes,
    paymentMethodsRes, autopayRes, ticketLinksRes, ticketSummariesRes, locationsRes, programRes,
    toolkitRes, assetsRes, proposalUvpsRes, proposalsRes, proposalEventsRes,
    newsletterRes, guidesRes,
  ] = await Promise.all([
    supabase.from('accounts').select('*').eq('id', accountId).maybeSingle(),
    supabase.from('recurring_services').select('*').eq('account_id', accountId).order('sort'),
    supabase.from('projects').select('*').eq('account_id', accountId).order('sort'),
    // Trim the bulk leads load to list-view columns only. The heavy panel-only
    // columns (journey ~650kB, message ~140kB across 800+ leads) are lazy-fetched
    // per-lead when a detail panel opens — they were dominating page-load time.
    // last_synced_at is stamped on every row by sync-whatconverts, so the max
    // across leads = when intake last pulled. The proposals cockpit shows it, so
    // "Sync intake" can report real freshness instead of implying it.
    supabase.from('leads').select('wc_lead_id, name, email, phone, company, source, quality, quotable, lead_status, value, quote_value, sales_value, type, time_label, created_at, last_synced_at, wc_account_id, page, fields, context, sort').eq('account_id', accountId).order('sort'),
    supabase.from('activity').select('*').eq('account_id', accountId).order('sort'),
    supabase.from('tickets').select('*').eq('account_id', accountId).order('sort'),
    supabase.from('kpis').select('*').eq('account_id', accountId).order('sort'),
    supabase.from('roi').select('*').eq('account_id', accountId).limit(1).maybeSingle(),
    supabase.from('library_resources').select('*').order('sort'),
    supabase.from('account_badges').select('*, badges(*)').eq('account_id', accountId).order('sort'),
    supabase.from('weekly_snapshots').select('*, weekly_snapshot_items(*)').eq('account_id', accountId).eq('is_current', true).maybeSingle(),
    supabase.from('weekly_snapshots').select('week_label, pdf_path').eq('account_id', accountId).eq('is_current', false).order('sort'),
    supabase.from('roadmap_quarters').select('*, roadmap_focuses(*)').eq('account_id', accountId).order('sort'),
    supabase.from('action_items').select('*').eq('account_id', accountId).order('sort'),
    supabase.from('invoices').select('*').eq('account_id', accountId).order('sort'),
    supabase.from('profiles').select('id, name, initials, avatar_url, role, is_staff, title').eq('account_id', accountId),
    supabase.from('quickbooks_payment_methods').select('*').eq('account_id', accountId).order('created_at', { ascending: false }),
    supabase.from('autopay_schedules').select('*').eq('account_id', accountId).maybeSingle(),
    supabase.from('ticket_links').select('zendesk_id, link, pct, label').eq('account_id', accountId),
    supabase.from('ticket_summaries').select('zendesk_id, summary, comment_count').eq('account_id', accountId),
    supabase.from('locations').select('*, location_milestones(*)').eq('account_id', accountId).order('sort'),
    supabase.from('program_quarters').select('*').eq('account_id', accountId).order('sort'),
    supabase.from('toolkit_systems').select('name, sort').eq('account_id', accountId).order('sort'),
    supabase.from('assets').select('*').eq('account_id', accountId).order('sort'),
    // Proposal system · this CAM's UVP library (the matcher's backbone). Ordered
    // by `position` so the array index === the canonical cap index that concern
    // matches reference. Empty for accounts not running proposals.
    supabase.from('proposal_uvps').select('*').eq('account_id', accountId).order('position'),
    // Proposal system · the pipeline. Raw submission + state; match/sections/
    // pricing are derived at load by enrichLead. Empty for non-proposals accounts.
    supabase.from('proposals').select('*').eq('account_id', accountId).order('sort'),
    // Proposal system · board engagement telemetry (Close). Aggregated per
    // proposal into the WATCH shape by enrichLead. Empty until a board opens one.
    supabase.from('proposal_events').select('*').eq('account_id', accountId).order('created_at'),
    // Newsletter intake · the client's current OPEN round, if any. Drives the
    // portal-wide "tell us what to feature" banner + the submit form. Empty for
    // accounts with no round open. Once submitted/closed it's no longer 'open',
    // so the banner clears automatically.
    supabase.from('newsletter_requests').select('*').eq('account_id', accountId).eq('status', 'open').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    // Guides · metadata only (the large `html` is lazy-fetched when a guide is
    // opened). Scoped to global (account_id null) + this account, explicitly —
    // so staff viewing a client see that client's guides, not every account's.
    supabase.from('guides').select('id, account_id, title, description, category, tag, sort').or(`account_id.is.null,account_id.eq.${accountId}`).order('sort'),
  ]);

  if (accountRes.error) throw accountRes.error;

  const profile = (me && me.profile) || {};
  const account = accountRes.data;

  // No such account (bad id / nothing to show) → null so AuthGate can react.
  if (!account) return null;
  const roi = roiRes.data;

  const snap = snapCurRes.data;
  const items = snap?.weekly_snapshot_items || [];
  const byKind = (kind) =>
    items
      .filter((i) => i.kind === kind)
      .sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map((i) => ({ text: i.text, meta: i.meta }));

  // A "Q<n> Planning" Monday item that isn't complete (status !== 'live') means
  // the current quarter is still being planned → dashboard shows the Planning
  // state. Excluded from the project lists below so it never shows as work/counts.
  const planningActive = (projectsRes.data || []).some(
    (p) => isPlanningItem(p.title) && p.status !== 'live',
  );

  return {
    // Current quarter still in planning (a non-complete "Q<n> Planning" item exists).
    planningActive,
    user: {
      id: session.user.id,
      name: profile.name || '',
      email: session.user.email || profile.email || '',
      initials: profile.initials || '',
      role: profile.role || 'owner',
      isStaff: !!profile.is_staff,
      avatarUrl: profile.avatar_url || null,
      tourCompletedAt: profile.tour_completed_at || null,
      notificationPrefs: profile.notification_prefs || {},
    },
    account: {
      id: account.id,
      company: account.company,
      shortName: account.short_name,
      tier: account.tier,
      market: account.market,
      locations: Array.isArray(account.locations) ? account.locations : [],
      since: account.since,
      goalLabel: account.goal_label || 'boards signed',
      goalCurrent: account.goal_current || 0,
      goalTarget: account.goal_target || 0,
      logoUrl: account.logo_url || null,
      // Dash guest-upload link for this brand — powers the "Upload Assets" sidebar
      // button (falls back to the shared DAM URL when unset).
      dashUploadUrl: account.dash_upload_url || null,
      // Pastel visual-feedback board URL — "Website update" requests route here.
      pastelUrl: account.pastel_url || null,
      // Integration ids — drive the Account page "Connected sources" card.
      mondayBoardId: account.monday_board_id || null,
      zendeskOrgId: account.zendesk_org_id || null,
      whatconvertsProfileId: account.whatconverts_profile_id || null,
      wcProfileNames: account.wc_profile_names || {}, // WC account_id -> display name
      // Lifetime WhatConverts tenure (weekly rollup).
      wcQualifiedTotal: account.wc_qualified_total || 0,
      wcQualifiedBySource: account.wc_qualified_by_source || {},
      wcQualifiedByYear: account.wc_qualified_by_year || {},
      wcFirstLeadAt: account.wc_first_lead_at || null,
      // Proposal system on/off (decision 1). Drives the Partnership↔Proposals
      // lens + the Proposals nav for client users.
      proposalsEnabled: !!account.proposals_enabled,
      // Quarters whose plan is published — the Quarterly Playbook card shows its
      // score only when the current quarter is listed here, else a Planning
      // state (so a pre-plan quarter doesn't read as bogus progress). '*' = always.
      planPublishedQuarters: Array.isArray(account.plan_published_quarters) ? account.plan_published_quarters : [],
    },
    roles: ROLES,
    recurringServices: (recurringRes.data || []).map((r) => ({
      id: r.id, name: r.name, short: r.short, cadence: r.cadence,
      lane: r.lane, color: r.color, lastTouch: r.last_touch, note: r.note,
    })),
    kpis: (kpisRes.data || []).map((k) => ({
      label: k.label, value: k.value, trend: k.trend, up: k.up, icon: k.icon, tone: k.tone,
    })),
    // Active/delivered work. Items from Monday's "Planned Work" group (status
    // 'planned') are split into `plannedProjects` below so they never count in
    // the active project views (sidebar, dashboard, Projects screen, card stats).
    projects: (projectsRes.data || []).filter((p) => p.status !== 'planned' && !isPlanningItem(p.title)).map((p) => ({
      id: p.code || p.monday_item_id, title: p.title, phase: p.phase, engines: p.engines || [],
      pct: p.pct, status: p.status, origin: p.origin || 'added',
      due: p.due_label || '', dueRel: p.due_rel || relativeDue(p.due_date), dueDate: p.due_date || null,
      owners: p.owners || [], pulse: p.pulse, subtasks: p.subtasks || [],
    })),
    // Opt-in systems the client has switched on (Monday "Toolkit" group).
    toolkit: (toolkitRes.data || []).map((t) => ({ name: t.name })),
    // Finished deliverables synced from the client's Dash DAM brand folder
    // (sync-dash-assets) → the Assets page. Grouped by category in the UI.
    assets: (assetsRes.data || []).map((a) => ({
      id: a.id, name: a.name, note: a.note || '', category: a.category || 'Other',
      format: a.format || '', formats: a.formats || [], spec: a.spec || '',
      fileCount: a.file_count || null, updated: a.updated_label || '',
      thumb: a.thumb_url || null, download: a.download_url || null,
    })),
    // Planned/queued work → Account page "On the horizon".
    plannedProjects: (projectsRes.data || []).filter((p) => p.status === 'planned' && !isPlanningItem(p.title)).map((p) => ({
      id: p.code || p.monday_item_id, title: p.title, phase: p.phase || null,
      dueDate: p.due_date || null, dueLabel: p.due_label || '',
    })),
    // Zendesk ticket id → Monday "Link" (Pastel/review URL) for the "Review Now"
    // button, and → subtask-% (stage progress) for the ticket card bar.
    ticketLinks: Object.fromEntries((ticketLinksRes.data || []).filter((t) => t.link).map((t) => [t.zendesk_id, t.link])),
    ticketLinkLabels: Object.fromEntries((ticketLinksRes.data || []).filter((t) => t.label).map((t) => [t.zendesk_id, t.label])),
    ticketProgress: Object.fromEntries((ticketLinksRes.data || []).filter((t) => t.pct != null).map((t) => [t.zendesk_id, t.pct])),
    // Cached AI one-line summaries (Zone 1 "Waiting on you" cards). Seeded here
    // so cards show last-known text instantly; ProjectsScreen calls
    // `summarize-tickets` on mount to refresh/generate any that updated.
    ticketSummaries: Object.fromEntries((ticketSummariesRes.data || []).filter((t) => t.summary).map((t) => [t.zendesk_id, t.summary])),
    // Cached public comment count per ticket → "X messages" on the Zone 1 cards.
    ticketCounts: Object.fromEntries((ticketSummariesRes.data || []).filter((t) => t.comment_count != null).map((t) => [t.zendesk_id, t.comment_count])),
    recentLeads: (leadsRes.data || []).map((l) => ({
      id: l.wc_lead_id, name: l.name, email: l.email, phone: l.phone, company: l.company, source: l.source,
      quality: l.quality, quotable: l.quotable, leadStatus: l.lead_status,
      value: l.value, quoteValue: l.quote_value, salesValue: l.sales_value,
      type: l.type, time: l.time_label, date: l.created_at, fields: l.fields, context: l.context, page: l.page,
      lastSyncedAt: l.last_synced_at || null,
      wcAccountId: l.wc_account_id || null, // which WhatConverts profile it came from
      // message + journey lazy-loaded in the lead detail panel (see LeadsScreen)
    })),
    // When intake last pulled from WhatConverts (max stamp across leads). Null
    // when the account has never synced. Drives the cockpit's freshness pill —
    // without it "Sync intake now" reads as a status when it's just a button.
    intakeSyncedAt: (leadsRes.data || []).reduce(
      (max, l) => (l.last_synced_at && (!max || l.last_synced_at > max) ? l.last_synced_at : max), null),
    activity: (activityRes.data || []).map((a) => ({
      color: a.color, text: a.text, meta: a.meta,
    })),
    tickets: (ticketsRes.data || []).map((t) => ({
      id: t.code, title: t.title, priority: t.priority, status: t.status,
      agent: t.agent, time: t.time_label, excerpt: t.excerpt, createdAt: t.created_at,
    })),
    weeklySnapshot: {
      weekLabel: snap?.week_label || '',
      headline: snap?.headline || '',
      note: snap?.note || '',
      status: snap?.status || '',
      pdf: snap?.pdf_path || '',
      quarterlyHref: snap?.quarterly_href || 'roi',
      summary: {
        waiting: snap?.summary_waiting || 0,
        leads: snap?.summary_leads || 0,
        leadsValue: snap?.leads_value || '',
        completed: snap?.summary_completed || 0,
      },
      waiting: byKind('waiting'),
      completed: byKind('completed'),
      upcoming: byKind('upcoming'),
      lead: byKind('lead'),
      past: (snapPastRes.data || []).map((s) => ({ label: s.week_label, file: s.pdf_path })),
    },
    roadmap: (roadmapRes.data || []).map((q) => ({
      q: q.quarter, months: q.months, title: q.title, state: q.state, file: q.pdf_path,
      focuses: (q.roadmap_focuses || [])
        .slice()
        .sort((a, b) => (a.sort || 0) - (b.sort || 0))
        .map((f) => ({ t: f.text, s: f.status })),
    })),
    // Growth Roadmap markets (tracks). Each market sits at a stage (0-4); its
    // current-stage milestones come from Monday subitems (done flags). msDone =
    // how many hit; msFresh = the most-recently-hit one (the "JUST HIT" coin).
    locations: (locationsRes.data || []).map((l) => {
      const ms = (l.location_milestones || []).slice().sort((a, b) => (a.idx || 0) - (b.idx || 0));
      const done = ms.filter((m) => m.done);
      let msFresh = -1, freshAt = 0;
      done.forEach((m) => { const t = m.done_at ? new Date(m.done_at).getTime() : 0; if (t >= freshAt) { freshAt = t; msFresh = m.idx; } });
      return {
        id: l.id, name: l.name, role: l.role || '', onboarded: l.onboarded || null,
        age: monthsSinceLabel(l.onboarded),
        stage: l.stage || 0,
        msDone: done.length,
        msFresh: freshAt ? msFresh : -1,
        metric: { value: l.metric_value || null, label: l.metric_label || null, delta: l.metric_delta || null },
        milestones: ms.map((m) => ({ idx: m.idx, label: m.label, done: !!m.done, doneAt: m.done_at || null })),
      };
    }),
    // Growth Engine program quarters (Plan -> Build -> Prove). Calendar quarters
    // from the client's start; proof + deliverable links from the Monday Program
    // board. Initiatives are reused from DATA.projects (grouped by quarter).
    programQuarters: (programRes.data || []).filter((q) => q.quarter_start).map((q) => ({
      id: q.id, label: q.label, quarterStart: q.quarter_start, proof: q.proof || null,
      playbookUrl: q.playbook_url || null, reportUrl: q.report_url || null, sort: q.sort,
    })),
    badges: (badgesRes.data || []).map((ab) => ({
      id: ab.badges?.slug,
      name: ab.badges?.name,
      desc: ab.badges?.description,
      color: ab.badges?.color,
      category: ab.badges?.category,
      state: ab.state,
      pct: ab.pct,
      earned: ab.earned_label,
    })),
    roi: roi
      ? {
          yearLabel: roi.year_label,
          invested: Number(roi.invested),
          contractValue: Number(roi.contract_value),
          boardsSigned: roi.boards_signed,
          ratio: Number(roi.ratio),
          rankingsTracked: roi.rankings_tracked,
          rankingsTop10: roi.rankings_top10,
        }
      : {},
    library: (libraryRes.data || []).map((r) => ({
      lane: r.lane, stage: r.stage, ttl: r.title, meta: r.meta, desc: r.description,
    })),
    actionQueue: (actionRes.data || []).map((a) => ({
      title: a.title, due: a.due_label || '', dueRel: relativeDue(a.due_date),
      zendeskId: a.zendesk_id || null, zendeskUrl: a.zendesk_url || null,
      routeId: a.zendesk_id || a.monday_item_id,
    })),
    // QuickBooks invoices (synced nightly). Download the PDF on demand via the
    // quickbooks-invoice-pdf function, passing `id`. UI gates on perms `billing`.
    invoices: (invoicesRes.data || []).map((inv) => ({
      id: inv.id, docType: inv.doc_type, number: inv.doc_number, date: inv.txn_date, dueDate: inv.due_date,
      description: inv.description,
      amount: Number(inv.total_amount), balance: Number(inv.balance),
      status: inv.status, currency: inv.currency,
    })),
    // Bank method on file (last-4 only) + the autopay schedule — for the
    // Account page's Billing section (gated by perms `billing`).
    paymentMethod: (() => {
      const m = (paymentMethodsRes.data || [])[0];
      return m ? { bankName: m.bank_name, accountType: m.account_type, last4: m.last4, status: m.verification_status, authorizedAt: m.ach_authorized_at } : null;
    })(),
    autopay: autopayRes.data
      ? { amount: Number(autopayRes.data.amount), billingDay: autopayRes.data.billing_day, startDate: autopayRes.data.start_date, status: autopayRes.data.status }
      : null,
    // Everyone on this account. The Account page splits this into client
    // "Team seats" (is_staff=false) and "Your Alloy team" (is_staff=true).
    // Email is not included (lives in auth.users, not client-readable).
    team: (teamRes.data || []).map((p) => ({
      id: p.id, name: p.name || '', initials: p.initials || '',
      avatarUrl: p.avatar_url || null, role: p.role || 'owner', isStaff: !!p.is_staff,
      // Real job title, for proposals and the board document. role is a PERMISSION
      // level and must never be shown to a prospect as a title.
      title: p.title || '',
    })),
    // Proposal system · the CAM's UVP library, in canonical cap order. Shape
    // mirrors src/lib/proposalUVPs.js so the UVP Library + matcher consume it
    // exactly like the mock. `_position` is the cap index; `_dbId` is the row id
    // for write-back. Absent/empty for accounts not running proposals → the UI
    // falls back to the canonical mock list.
    proposalUvps: (proposalUvpsRes.data || []).map((u) => ({
      id: u.slug, title: u.title, short: u.short || '', body: u.body || '',
      icon: u.icon || 'sparkles', category: u.category || 'operations',
      tags: u.tags || [],
      proof: (u.proof_value || u.proof_label) ? { value: u.proof_value, label: u.proof_label } : null,
      active: u.active, _dbId: u.id, _position: u.position,
    })),
    // Proposal system · the pipeline. Each DB row → the raw submission shape →
    // enrichLead (match/concerns/sections/pricing/Close telemetry), so the
    // cockpit renders these identically to the mock LEADS. Real board-engagement
    // events (grouped per proposal) flow in so Close shows live data; enrichLead
    // aggregates them, falling back to mock WATCH when a proposal has none.
    // Archived rows are split OUT of the pipeline here rather than filtered in
    // each view — there are six views plus the stepper counts, and missing one
    // would leak spam back into the cockpit. See archivedProposals below.
    proposals: (() => {
      const eventsByProposal = {};
      (proposalEventsRes.data || []).forEach((e) => {
        (eventsByProposal[e.proposal_id] = eventsByProposal[e.proposal_id] || []).push(e);
      });
      const cam = camFor(accountId); // white-label the matcher to this account's CAM
      return (proposalsRes.data || []).filter((p) => !p.archived_at).map((p) =>
        enrichLead({ ...proposalRowToRaw(p), events: eventsByProposal[p.id] || [] }, cam));
    })(),
    // The Archive bin. Deliberately NOT run through enrichLead — the matcher is
    // real work and a bin only needs identity + why/when it was archived.
    //
    // These rows are also what stops the intake auto-drain re-minting spam: it
    // dedupes on "already has a proposal", so the tombstone must stay visible to
    // it. src/lib/intakeDrain.js takes these ids in existingIds.
    archivedProposals: (proposalsRes.data || []).filter((p) => p.archived_at).map((p) => ({
      id: p.lead_key,
      community: p.community, contact: p.contact, city: p.city, homes: p.homes,
      email: p.email, quote: p.quote,
      receivedAt: p.received_at || null, received: p.received,
      archivedAt: p.archived_at, archivedReason: p.archived_reason || '', archivedBy: p.archived_by || '',
      wasDisq: !!p.disq, status: p.status,
    })),
    // Newsletter intake · the current open round for this account (or null).
    // camelCased for the banner + submit form. `submission` stays null until
    // the client fills it in.
    newsletterRequest: newsletterRes && newsletterRes.data ? {
      id: newsletterRes.data.id,
      title: newsletterRes.data.title || 'Newsletter',
      status: newsletterRes.data.status,
      dueDate: newsletterRes.data.due_date || null,
      submission: newsletterRes.data.submission || null,
    } : null,
    // Guides · metadata for the Guides page (html lazy-fetched on open).
    guides: (guidesRes && guidesRes.data || []).map((g) => ({
      id: g.id, title: g.title, description: g.description, category: g.category || 'Guides',
      tag: g.tag || null, scope: g.account_id ? 'client' : 'global',
    })),
  };
}

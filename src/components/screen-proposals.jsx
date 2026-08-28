import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { I } from './icons.jsx';
import { getLeads, enrichLead, PAIN_POINTS, pricing, freshWatch } from '../lib/proposalMockData.js';
import { camFor } from '../lib/camProfiles.js';
import { leadToProposalRaw } from '../lib/proposalIntake.js';
import { recommendTier, tierById, TIERS } from '../lib/proposalTier.js';
import { deriveTierAndPrice } from '../lib/proposalReprice.js';
import {
  BUDGET_OPTIONS, TIMELINE_OPTIONS, COMMUNITY_TYPE_OPTIONS,
  MANAGEMENT_STATUS_OPTIONS, ROLE_OPTIONS, withCurrent, isOffList,
} from '../lib/intakeVocab.js';
import { parseCcInput, CC_MAX } from '../lib/ccList.js';
import { selectIntakeBatch, junkStatusForReason } from '../lib/intakeDrain.js';
import { qualifyLead } from '../lib/leads.js';
import { ownersFromTeam, ownerFor, ownerShortLabel } from '../lib/proposalOwners.js';
import { canMintProposals } from '../lib/proposalAccess.js';
import {
  stageOf, uiStageOf, inWon, inLost, sentOutsidePortal,
  stageMoves, stageMovePatch, stageSnapshot, stageMoveLabel, stageNeeds,
  STAGE_LABEL,
} from '../lib/proposalStage.js';
import { receivedMs, fmtReceived, ageAgo, agePriority, syncFreshness } from '../lib/leadAge.js';
import { matchLeadWithLLM, realignFromTranscript, LLM_ENABLED } from '../lib/proposalLLM.js';
import { MatchRing, MatchingEngine } from './proposal-shared.jsx';
import UVPLibrary from './screen-uvp-library.jsx';
import { DATA } from '../data.js';
import { supabase, isSupabaseConfigured } from '../lib/supabase.js';
import lottie from 'lottie-web/build/player/lottie_light';
import scanningData from '../assets/scanning.json';
import sendingMailData from '../assets/sending-mail.json';

// The white-label CAM identity for the account being viewed. DATA is a live
// singleton populated before the cockpit renders, so this resolves per render.
// caps index into cam.uvps (the same set the matcher derived against).
const cam = () => camFor(DATA.account?.id);
// The account's REAL people. The picker used to be a literal ['AB','JR'], where
// JR resolved to "Jordan R." — a person who does not exist on CMGT — while Jeff
// Harman, the actual account owner, was not offered at all. DATA.team is loaded
// by loadData; nothing here was using it.
const owners = () => ownersFromTeam(DATA.team);
// Stored owner key -> a person. Falls back to the CAM profile so a proposal filed
// under someone since removed still shows a name rather than raw initials.
const ownerOf = (key) => ownerFor(owners(), key, cam().reps);
const ownerFirstOf = (key) => (ownerOf(key) || {}).first || key || cam().shortName;
const camTitles = () => cam().uvps.map((u) => u.title);
const camBlurbs = () => cam().uvps.map((u) => u.short);

// ============================================================================
// Proposals — CAM staff cockpit, v15 (Review → Build → Send → Close · Retain).
//
// All five surfaces built on mock data: Review (match analysis + engine modal),
// Build (section checklist + LIVE board-doc preview + "Open full proposal"),
// Send (email mockup + launch → Sent), Close (post-send engagement analytics),
// Retain (handoff to the Retention module). Renders inside the portal shell.
//
// Match is computed live by the engine / LLM. "Watch" is "Close" user-facing.
// Styles: 15-proposals.css (scoped under .proposal-system).
// ============================================================================

const { useState, useRef, useLayoutEffect, useEffect } = React;
// The board link uses the unguessable board_token (the real magic-link secret)
// when present; falls back to the lead id only in mock dev (no token). The board
// page resolves the token anonymously via the proposal-board edge fn.
const BOARD_URL = (sub) => `/proposals/board/${(sub && sub.boardToken) || (sub && sub.id) || sub}`;

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const fmtMoney = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Inbox provenance time: "18m ago" / "3h ago" / "2d ago" within a week, the
// short date older, "" when unknown. (App-side Date.now is fine here.)
const relAgo = (ts) => {
  if (!ts) return '';
  const d = new Date(ts); const ms = Date.now() - d.getTime();
  if (isNaN(ms)) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days <= 6) return days === 1 ? 'yesterday' : `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const DISQ_REASONS = ['Budget below our floor', 'Outside service area', 'Renewed with current manager', 'Self-managing for now', 'Other'];

// stageOf / uiStageOf / the bucket predicates now live in src/lib/proposalStage.js
// alongside the stage-move contract, so what decides a stage and what CHANGES it
// are the same file. Imported at the top.

// Looping scan animation (replaces the old lightning-bolt) for the "matching"
// overlay. Cockpit-only — kept out of proposal-shared so the anonymous board
// bundle stays lottie-free.
function LottieScan({ size = 104, className, data = scanningData }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return undefined;
    const anim = lottie.loadAnimation({
      container: ref.current, renderer: 'svg', loop: true, autoplay: true,
      animationData: data, rendererSettings: { progressiveLoad: false },
    });
    return () => anim.destroy();
  }, []);
  return <span className={className} ref={ref} aria-hidden="true" style={{ width: size, height: size, display: 'block', margin: '0 auto' }} />;
}

const OWNER_COLORS = { AB: 'linear-gradient(135deg,#d9356e,#a82451)', JR: 'linear-gradient(135deg,#4b86b4,#2a6391)' };
function OwnerAvatar({ initials, size }) {
  const s = size || 26;
  return <span className="ps-sub-av" style={{ width: s, height: s, background: OWNER_COLORS[initials] || 'linear-gradient(135deg,#8a8395,#5d5468)' }}>{initials}</span>;
}

function QPill({ s }) {
  let cls = 'review', label = 'Qualified';
  if (s.disq) { cls = 'declined'; label = 'Not quotable'; }
  else if (s.status === 'new') { cls = 'new'; label = 'Pending'; }
  else if (s.status === 'accepted') { cls = 'accepted'; label = 'Won'; }
  else if (s.status === 'declined') { cls = 'declined'; label = 'Lost'; }
  else if (s.status === 'sent') { cls = 'sent'; label = 'Sent'; }
  else if (s.status === 'draft') { cls = 'review'; label = 'Drafting'; }
  return <span className={'ps-pill ps-pill--' + cls}><span className="d" />{label}</span>;
}

// Reusable toolbar icons (fresh element per call so they're never shared across trees).
const icoOpen = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14 21 3" /></svg>;
const icoEdit = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
const icoPhone = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /></svg>;
const icoResend = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" /></svg>;
const icoMove = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" /></svg>;

// The shared back-row toolbar used on every focused stage: back pill (left) +
// action pills (right, same .fx-back style; one optional pink primary).
function StageToolbar({ backLabel, onBack, actions }) {
  return (
    <div className="fx-back-row">
      <button className="fx-back" onClick={onBack}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg> {backLabel}</button>
      <div className="fx-back-acts">
        {(actions || []).filter(Boolean).map((a, i) => (
          <button key={i} className={'fx-back' + (a.primary ? ' fx-back--send' : '')} onClick={a.onClick}>{a.icon}{a.label}{a.arrow ? <span style={{ fontSize: 15, lineHeight: 1, marginLeft: 1 }}>→</span> : null}</button>
        ))}
      </div>
    </div>
  );
}

const MATCH_SEGS = 7;
function MatchConcern({ concern, uvps, blurbs, index, onEdit, onRemove }) {
  const [open, setOpen] = useState(false);
  const strong = concern.fit >= 85;
  const lit = Math.round(concern.fit / 100 * MATCH_SEGS);
  const nCaps = concern.caps.length;
  return (
    <div className={'v2-match' + (open ? ' open' : '')}>
      <div className="v2-match-row" onClick={() => setOpen(!open)}>
        <span className="v2-match-ic">{index}</span>
        <span className="v2-match-name">{concern.label}</span>
        {concern.source === 'narrative' && (
          <span title="The AI surfaced this concern from what the board wrote in their own words — not a pain-point checkbox they selected." style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700, letterSpacing: '.02em', textTransform: 'uppercase', color: '#a82451', background: 'var(--alloy-pink-tint, rgba(168,36,81,.08))', border: '1px solid rgba(168,36,81,.22)', borderRadius: 999, padding: '2px 8px', marginRight: 8, whiteSpace: 'nowrap' }}>
            <I.Sparkle width={10} height={10} /> From their note
          </span>
        )}
        {onEdit && (
          <button className="fx-con-act" title="Edit concern" onClick={(e) => { e.stopPropagation(); onEdit(); }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          </button>
        )}
        {onRemove && (
          <button className="fx-con-act danger" title="Remove concern" onClick={(e) => { e.stopPropagation(); onRemove(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        )}
        <span className={'v2-seg-chev' + (open ? ' open' : '')}><I.Chevron width={16} height={16} /></span>
      </div>
      <div className="v2-seg-wrap" onClick={() => setOpen(!open)}>
        <div className="v2-segs">
          {Array.from({ length: MATCH_SEGS }).map((_, i) => (
            <span key={i} className={'v2-seg' + (i < lit ? (strong ? ' on-strong' : ' on-partial') : '')} style={{ transitionDelay: (i * 45) + 'ms' }} />
          ))}
        </div>
        <span className="v2-seg-val">{concern.fit}%</span>
      </div>
      <div className={'v2-seg-cap ' + (strong ? 'strong' : 'partial')}>
        <span className="dot" /><b>{strong ? 'Strong match' : 'Partial match'}</b> · {`${nCaps} ${nCaps === 1 ? 'strength' : 'strengths'} answer this`}
      </div>
      {open && (
        <div className="v2-match-detail">
          {concern.caps.map((ci, k) => (
            <div className="v2-cap" key={k}>
              <span className="v2-cap-ic"><I.Bolt width={14} height={14} /></span>
              <div><div className="v2-cap-name">{uvps[ci]}{k === 0 && <span className="v2-cap-fit">top fit</span>}</div><div className="v2-cap-blurb">{blurbs[ci]}</div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QualifyModal({ s, onClose, onQualify, onDisqualify }) {
  const [tab, setTab] = useState('qualify');
  const [owner, setOwner] = useState(s.owner || (owners()[0] && owners()[0].initials) || '');
  const [val, setVal] = useState(s.quoteValue);
  const [reason, setReason] = useState(DISQ_REASONS[0]);
  return (
    <div className="ps-scrim" onClick={onClose}>
      <div className="ps-modal v2-qual-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ps-modal-head">
          <span className="t">Qualify · {s.community}</span>
          <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600 }}>{s.homes} homes · {s.city}</span>
          <button className="x" onClick={onClose}><I.Close width={15} height={15} /></button>
        </div>
        <div className="v2-qual-tabs">
          <button data-on={tab === 'qualify'} onClick={() => setTab('qualify')}>Move to qualified</button>
          <button data-on={tab === 'disq'} onClick={() => setTab('disq')}>Not quotable</button>
        </div>
        {tab === 'qualify' ? (
          <div className="v2-qual-body">
            <label className="v2-qual-label">Sales owner</label>
            <div className="v2-qual-owners">
              {owners().map((o) => (
                <button key={o.initials} className="v2-qual-owner" data-on={owner === o.initials} onClick={() => setOwner(o.initials)}>
                  <OwnerAvatar initials={o.initials} size={24} /><span>{ownerShortLabel(o)}</span>
                  {owner === o.initials && <span className="v2-qual-tick"><I.Check width={12} height={12} /></span>}
                </button>
              ))}
              {owners().length === 0 && (
                <div className="v2-qual-hint">Nobody on this account yet — invite the team from Account Details and they'll appear here.</div>
              )}
            </div>
            <label className="v2-qual-label">Estimated quote value <span>· annual contract</span></label>
            <div className="v2-qual-money"><span>$</span><input type="number" min="0" step="100" value={val} onChange={(e) => setVal(parseFloat(e.target.value) || 0)} /><span className="u">/yr</span></div>
            <div className="v2-qual-hint">Auto-filled from the recommended tier ({s.tierName} · {pricing(s).monthly}/mo{pricing(s).floored ? ' — minimum fee applies' : ''}). Adjust if you've agreed otherwise.</div>
            <div className="v2-qual-actions">
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={() => { onQualify(s.id, owner, val); onClose(); }}><I.Check width={14} height={14} /> Qualify lead</button>
            </div>
          </div>
        ) : (
          <div className="v2-qual-body">
            <div className="v2-qual-warn">This lead won't get a proposal. It moves to <b>Closed</b> as not quotable — you can re-qualify it later.</div>
            <label className="v2-qual-label">Reason</label>
            <div className="v2-qual-reasons">
              {DISQ_REASONS.map((r) => (
                <button key={r} className="v2-qual-reason" data-on={reason === r} onClick={() => setReason(r)}><span className="v2-qual-radio" data-on={reason === r} />{r}</button>
              ))}
            </div>
            <div className="v2-qual-actions">
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn v2-btn-danger" onClick={() => { onDisqualify(s.id, reason); onClose(); }}>Mark not quotable</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Move stage ──────────────────────────────────────────────────────────────
// One control for every stage change, replacing the old one-way buttons (and the
// WinModal that used to be the ONLY way to record a signed value). The stage
// stays derived from status/disq; src/lib/proposalStage.js owns which fields a
// given move writes, so nothing here hand-maintains a patch.
const MOVE_WARN = {
  notEmailed: () => (
    <>Nothing has been emailed from the portal for this proposal. It will sit in <b>Sent</b>
      {' '}marked <b>sent outside the portal</b>, with no opens, no read depth and no link
      countdown — because there is nothing here to track. Use <b>Send proposal</b> instead if
      you want the portal to email it and track it.</>
  ),
  boardLinkLive: () => <>The board's emailed link keeps working — they can still open this and reply.</>,
  boardVerdict: (w) => <>The board already responded (<b>{w.action}</b>). Their copy keeps showing that until you resend.</>,
  eventsHidden: (w) => <><b>{w.n}</b> board engagement {w.n === 1 ? 'event stays' : 'events stay'} recorded, but the engagement panel only renders in Sent.</>,
  clearsSalesValue: (w) => <>The signed value ({money(w.value)}/yr) will be cleared.</>,
  reopensClosed: (w) => <>This reopens a closed deal — it leaves <b>{w.from}</b>.</>,
};

function MoveStageModal({ s, live, onClose, onMove, onSendInstead }) {
  const here = uiStageOf(s);
  const moves = stageMoves(s);
  const [target, setTarget] = useState(null);
  const [owner, setOwner] = useState(s.owner || (owners()[0] && owners()[0].initials) || '');
  const [quote, setQuote] = useState(s.quoteValue);
  const [sales, setSales] = useState(s.salesValue != null ? s.salesValue : s.quoteValue);
  const [reason, setReason] = useState(DISQ_REASONS[0]);

  const opts = { owner, quoteValue: quote, salesValue: sales, disqReason: reason };
  // The contract decides everything: which fields change, what's still missing,
  // and what to warn about. The modal only renders it.
  const preview = target ? stageMovePatch(s, target, opts) : null;
  const needs = target ? stageNeeds(target) : null;
  const blocked = !target || !!(preview && preview.error);
  const tone = target === 'won' ? 'v2-btn-win' : (target === 'lost' || target === 'disq') ? 'v2-btn-danger' : 'btn-primary';

  return (
    <div className="ps-scrim" onClick={onClose}>
      <div className="ps-modal v2-qual-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ps-modal-head">
          <span className="t">Move · {s.community}</span>
          <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600 }}>Currently in {STAGE_LABEL[here]} · {s.homes} homes</span>
          <button className="x" onClick={onClose} aria-label="Close"><I.Close width={15} height={15} /></button>
        </div>
        <div className="v2-qual-body">
          <label className="v2-qual-label">Move to</label>
          <div className="v2-qual-reasons">
            {moves.map((m) => (
              <button key={m.id} className="v2-qual-reason" data-on={target === m.id} onClick={() => setTarget(m.id)}>
                <span className="v2-qual-radio" data-on={target === m.id} />{m.label}
              </button>
            ))}
          </div>

          {needs === 'ownerQuote' && (<>
            <label className="v2-qual-label">Sales owner</label>
            <div className="v2-qual-owners">
              {owners().map((o) => (
                <button key={o.initials} className="v2-qual-owner" data-on={owner === o.initials} onClick={() => setOwner(o.initials)}>
                  <OwnerAvatar initials={o.initials} size={24} /><span>{ownerShortLabel(o)}</span>
                  {owner === o.initials && <span className="v2-qual-tick"><I.Check width={12} height={12} /></span>}
                </button>
              ))}
              {owners().length === 0 && (
                <div className="v2-qual-hint">Nobody on this account yet — invite the team from Account Details and they'll appear here.</div>
              )}
            </div>
            <label className="v2-qual-label">Estimated quote value <span>· annual contract</span></label>
            <div className="v2-qual-money"><span>$</span><input type="number" min="0" step="100" value={quote} onChange={(e) => setQuote(parseFloat(e.target.value) || 0)} /><span className="u">/yr</span></div>
          </>)}

          {needs === 'salesValue' && (<>
            <label className="v2-qual-label">Signed sales value <span>· annual contract</span></label>
            <div className="v2-qual-money"><span>$</span><input type="number" min="0" step="100" value={sales} onChange={(e) => setSales(parseFloat(e.target.value) || 0)} /><span className="u">/yr</span></div>
            <div className="v2-qual-hint">{here === 'new'
              ? <>Prefilled from the recommended tier ({s.tierName}) — nobody has quoted this yet.</>
              : <>Prefilled from the quote ({money(s.quoteValue)}/yr). Adjust to what the board actually signed.</>}</div>
          </>)}

          {needs === 'disqReason' && (<>
            <label className="v2-qual-label">Reason</label>
            <div className="v2-qual-reasons">
              {DISQ_REASONS.map((r) => (
                <button key={r} className="v2-qual-reason" data-on={reason === r} onClick={() => setReason(r)}><span className="v2-qual-radio" data-on={reason === r} />{r}</button>
              ))}
            </div>
          </>)}

          {(preview ? preview.warnings : []).map((w) => (
            <div key={w.code} className="v2-qual-warn">{(MOVE_WARN[w.code] || (() => w.code))(w)}</div>
          ))}
          {target === 'sent' && !s.sentAt && (
            <div className="v2-qual-actions" style={{ justifyContent: 'flex-start' }}>
              <button className="btn btn-secondary" onClick={() => { onClose(); onSendInstead(); }}>Send proposal instead</button>
            </div>
          )}
          {!live && <div className="v2-qual-warn">Mock dev — this move won't be saved.</div>}

          <div className="v2-qual-actions">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className={'btn ' + tone} disabled={blocked} onClick={() => { onMove(s.id, target, opts); onClose(); }}>
              {target ? stageMoveLabel(target) : 'Move'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── New stage · VIEW 1: inbox grid of un-worked (status:"new") leads ──
// A lead lives here in one of two states until it's qualified & built:
//   new  — arrived from intake, never opened → stands out (pink accent)
//   seen — opened by a CAM, not yet qualified → recedes (gray "Reviewed")
function InboxLead({ s, onOpen, onArchive }) {
  const seen = !!s.openedAt;
  // Age comes from the lead's real submission time, NOT the row's mint time —
  // see leadAge.js. The absolute stamp sits beside the age so "1mo ago" is
  // always backed by a date the CAM can quote on a call.
  const rms = receivedMs(s);
  const when = seen
    ? `Opened by ${s.openedBy || 'a teammate'}${relAgo(s.openedAt) ? ' · ' + relAgo(s.openedAt) : ''}`
    : 'Not yet opened';
  return (
    <div className="fx-lead" data-state={seen ? 'seen' : 'new'} onClick={() => onOpen(s.id)} role="button" tabIndex={0}>
      <div className="fx-lead-top">
        <span className="fx-lead-name">{s.community}</span>
        {seen
          ? <span className="fx-badge seen">Reviewed</span>
          : <span className="fx-badge new"><span className="d" />New</span>}
        <span className="fx-lead-pct"><b>{s.match}%</b><span>match</span></span>
        {onArchive && (
          <button className="fx-lead-kill" title="Remove this lead (spam, duplicate, test)"
            aria-label={`Remove ${s.community}`}
            onClick={(e) => { e.stopPropagation(); onArchive(s); }}><I.Trash width={14} height={14} /></button>
        )}
      </div>
      <div className="fx-lead-meta">{s.contact} · {s.homes} homes · {s.city}</div>
      <div className="fx-lead-recv" data-age={agePriority(rms)}>
        <I.Clock width={12} height={12} />
        {rms != null
          ? <>Received {fmtReceived(rms)}<b>{ageAgo(rms)}</b></>
          : <>Received date unknown</>}
      </div>
      {s.quote && <div className="fx-lead-quote">"{s.quote}"</div>}
      <div className="fx-lead-foot">
        <span className={'fx-lead-when' + (seen ? ' seen' : '')}><span className="arr" /> {when}</span>
        <button className={'fx-open' + (seen ? ' ghost' : '')} onClick={(e) => { e.stopPropagation(); onOpen(s.id); }}>Open <span>→</span></button>
      </div>
    </div>
  );
}

function InboxGrid({ pending, onOpen, pendingMore, onSyncMore, syncing, onArchive }) {
  const sorted = [...pending].sort((a, b) => (b.match || 0) - (a.match || 0));
  const fresh = sorted.filter((s) => !s.openedAt);     // never opened
  const reviewed = sorted.filter((s) => s.openedAt);   // opened, not yet qualified
  const total = sorted.length, nNew = fresh.length;
  return (
    <div>
      <div className="fx-inbox-head">
        <div style={{ minWidth: 0 }}>
          <div className="fx-eyebrow">New leads · straight from intake</div>
          <h2 className="fx-h">
            {nNew > 0 && <><span className="nu">{nNew} new</span> {nNew === 1 ? 'submission' : 'submissions'}, </>}
            {total} {total === 1 ? 'lead' : 'leads'} to work.
          </h2>
          <p className="fx-sub">Every intake submission lands here automatically — no importing. New ones are flagged until someone opens them, and every lead stays in this list until it's <b>qualified &amp; built</b> into a proposal.</p>
        </div>
      </div>
      {/* A capped drain must never look like a finished one — say what's left
          and give the CAM the button to pull the rest. */}
      {pendingMore > 0 && (
        <div className="fx-more">
          <span className="d" />
          <span><b>{pendingMore} more</b> intake {pendingMore === 1 ? 'lead is' : 'leads are'} waiting — this pass mints the newest 25 at a time.</span>
          <button onClick={onSyncMore} disabled={syncing}>{syncing ? 'Pulling…' : 'Pull the rest'}</button>
        </div>
      )}
      {total === 0 && pendingMore === 0 && <div className="fx-empty">You're all caught up — new intake submissions will appear here automatically.</div>}
      {nNew > 0 && (<>
        {/* "Just arrived" was a lie for anything but a fresh sync — this bucket is
            "never opened", and now that each card shows its true age a 90-day-old
            lead sitting here would contradict the header. */}
        <div className="fx-grouplbl"><span>Awaiting review</span> · <span className="ct">{nNew} new</span><span className="ln" /></div>
        <div className="fx-grid">{fresh.map((s) => <InboxLead key={s.id} s={s} onOpen={onOpen} onArchive={onArchive} />)}</div>
      </>)}
      {reviewed.length > 0 && (<>
        <div className="fx-grouplbl seen"><span>Reviewed · waiting to qualify</span> · <span className="ct">{reviewed.length}</span><span className="ln" /></div>
        <div className="fx-grid">{reviewed.map((s) => <InboxLead key={s.id} s={s} onOpen={onOpen} onArchive={onArchive} />)}</div>
      </>)}
    </div>
  );
}

// ── New stage · VIEW 2: slim rail of the other new leads (replaces the old tabs) ──
function NewRail({ pending, selectedId, onSelect }) {
  return (
    <div className="fx-rail">
      <div className="fx-rail-lbl">New leads · {pending.length}</div>
      {pending.map((s) => {
        const on = s.id === selectedId;
        return (
          <button key={s.id} className="fx-rail-item" data-on={on} onClick={() => onSelect(s.id)}>
            <div className="fx-rail-nm">{s.community}</div>
            {on
              // selected → richer so the column doesn't feel hollow
              ? <>
                  <div className="fx-rail-meta">{s.homes} homes · {s.city}</div>
                  <div className="fx-rail-contact"><span className="av">{(s.contact || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'}</span>{s.contact} · <span className="fx-rail-pct">{s.match}% match</span></div>
                </>
              : <div className="fx-rail-meta">{s.homes} homes · <span className="fx-rail-pct">{s.match}%</span></div>}
          </button>
        );
      })}
    </div>
  );
}

// ── Build · bucket list: every qualified lead still being written (so none get stranded) ──
function BuildRow({ s, secs, onResume }) {
  const total = secs.length || 1;
  const done = secs.filter((x) => x.on).length;
  const pr = pricing(s);
  return (
    <div className="fx-brow" onClick={() => onResume(s.id)} role="button" tabIndex={0}>
      <div className="fx-brow-l">
        <div className="fx-brow-nm">{s.community}</div>
        <div className="fx-brow-meta">{s.homes} homes · {s.city}</div>
      </div>
      <div className="fx-brow-prog">
        <div className="fx-brow-progbar"><i style={{ width: Math.round(done / total * 100) + '%' }} /></div>
        <div className="fx-brow-proglbl">{done} of {total} sections included</div>
      </div>
      <div className="fx-brow-fig"><div className="v">{pr.monthly}/mo</div><div className="k">Proposed</div></div>
      {s.owner && <div className="fx-brow-av">{s.owner}</div>}
      <button className="fx-brow-go" onClick={(e) => { e.stopPropagation(); onResume(s.id); }}>Resume →</button>
    </div>
  );
}

function BuildBucket({ subs, editorMap, onResume }) {
  const inBuild = subs.filter((s) => stageOf(s) === 'qualified' && s.status !== 'sent');
  return (
    <div>
      <div className="fx-inbox-head">
        <div style={{ minWidth: 0 }}>
          <div className="fx-eyebrow">In progress · being built</div>
          <h2 className="fx-h">{inBuild.length} {inBuild.length === 1 ? 'proposal' : 'proposals'} mid-build.</h2>
          <p className="fx-sub">Each qualified lead waits here while you write its proposal. Pick one to resume — the others hold their place.</p>
        </div>
      </div>
      {inBuild.length
        ? <div className="fx-blist">{inBuild.map((s) => <BuildRow key={s.id} s={s} secs={editorMap[s.id] || s.sections || []} onResume={onResume} />)}</div>
        : <div className="fx-empty">Nothing in build yet. Qualify a lead from <b>New</b> and it lands here.</div>}
    </div>
  );
}

// ── New stage shell: inbox grid (nothing drilled in) vs. the match-analysis drill-in ──
// What the intake form contradicts or leaves unusable. Shown BEFORE the concern
// list, because the alternative is a confident proposal built on a contradiction
// the board itself submitted — e.g. Chappell Creek ticked "developer-controlled"
// while answering "self-managed by board", with 12 units. The matcher was right;
// nothing asked which was true.
function IntakeFlags({ flags }) {
  if (!flags || !flags.length) return null;
  return (
    <div className="v2-card fx-flags">
      <div className="v2-block-label">Check with them first · {flags.length}</div>
      {flags.map((f) => (
        <div className="fx-flag" key={f.code}>
          <span className="fx-flag-ic" aria-hidden="true">!</span>
          <div>
            <div className="fx-flag-t">{f.label}</div>
            <div className="fx-flag-s">{f.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReviewScreen({ subs, selectedId, sub, inbox, onOpenLead, onBack, onSelectRail, onQualify, onDisqualify, onBuild, onEditDetails, onApplyMatch, perHome, setPerHome, onRealign, pendingMore, onSyncMore, syncing, onArchive, onMove }) {
  const [qualifyTarget, setQualifyTarget] = useState(null);
  const [showEngine, setShowEngine] = useState(false);
  const [concernEdit, setConcernEdit] = useState(null); // index | 'new' | null (Layer B)
  const [overallEdit, setOverallEdit] = useState(null); // editing the overall % (string) or null
  const pending = subs.filter((s) => stageOf(s) === 'pending');
  // Qualify & Build is one motion: assign owner + lock tier in the modal, then
  // advance straight into Build — entering Build *is* qualifying.
  const qualifyAndBuild = (id, owner, quoteValue) => { onQualify(id, owner, quoteValue); onBuild(); };
  const modal = qualifyTarget && (
    <QualifyModal s={qualifyTarget} onClose={() => setQualifyTarget(null)} onQualify={qualifyAndBuild} onDisqualify={onDisqualify} />
  );

  // VIEW 1 — inbox grid (nothing drilled in, or the selected lead isn't a new one)
  if (inbox || !sub || stageOf(sub) !== 'pending') {
    return (<>{modal}<InboxGrid pending={pending} onOpen={onOpenLead} pendingMore={pendingMore} onSyncMore={onSyncMore} syncing={syncing} onArchive={onArchive} /></>);
  }

  // VIEW 2 — match-analysis drill-in
  const pr = pricing(sub);
  const matched = sub.scores.filter((x) => x > 0).length;
  const links = sub.links.reduce((a, l) => a + l.length, 0);
  const fromNote = sub.concerns.filter((c) => c.source === 'narrative').length;
  return (
    <div>
      {modal}
      {showEngine && (
        <div className="ps-scrim" onClick={() => setShowEngine(false)}>
          <div className="v2-engine-modal" onClick={(e) => e.stopPropagation()}>
            <div className="v2-engine-modal-head">
              <div className="ps-engine-head">
                <span className="ps-engine-eyebrow">Matching engine</span>
                <span className="ps-engine-live"><span className="d" />LIVE</span>
                <span className="ps-engine-stats"><b>{sub.concerns.length}</b> concerns · <b>{matched}</b> matched · <b>{links}</b> links</span>
              </div>
              <button className="v2-engine-modal-x" onClick={() => setShowEngine(false)} aria-label="Close"><I.Close width={16} height={16} /></button>
            </div>
            <div className="v2-engine-modal-body">
              <div className="ps-graph-cols"><span className="ps-graph-col l">{sub.community} pain points</span><span className="ps-graph-col r">{cam().shortName} UVPs</span></div>
              <MatchingEngine concerns={sub.concerns} uvps={camTitles()} links={sub.links} />
            </div>
          </div>
        </div>
      )}

      <StageToolbar backLabel="Back to inbox" onBack={onBack} actions={[
        { icon: <I.Trash width={14} height={14} />, label: 'Remove lead', onClick: () => onArchive(sub) },
        { icon: icoPhone(), label: 'Update from call', onClick: onRealign },
        { icon: icoEdit(), label: 'Edit details', onClick: onEditDetails },
        // Closing a deal on a phone call before anything is built or sent is a
        // real motion; Qualify & Build stays the primary happy path.
        { icon: icoMove(), label: 'Move / close', onClick: () => onMove(sub) },
        { label: 'Qualify & Build', onClick: () => setQualifyTarget(sub), primary: true, arrow: true },
      ]} />

      {/* Pin = info only; actions live in the toolbar (consistent across stages). */}
      <PinnedCard sub={sub} stage="new" perHome={perHome} setPerHome={setPerHome} />

      <div className="fx-analysis2">
        <div>
          <IntakeFlags flags={sub.intakeFlags} />
      <div className="v2-match-head">
            <MatchRing value={sub.match} size={58} />
            <div className="v2-match-head-text">
              <h3 className="v2-match-h">Currently Matching “{sub.community}” with {cam().shortName}’s Expertise</h3>
              <div className="v2-match-meta"><b>{sub.concerns.length}</b> concerns&nbsp;·&nbsp;<b>{matched}</b> capabilities matched&nbsp;·&nbsp;from their intake form
                {overallEdit !== null
                  ? <span className="fx-overall-edit"><input type="number" min="0" max="100" value={overallEdit} autoFocus onChange={(e) => setOverallEdit(e.target.value)} onBlur={() => { onApplyMatch(sub.concerns, parseInt(overallEdit) || 0); setOverallEdit(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { onApplyMatch(sub.concerns, parseInt(overallEdit) || 0); setOverallEdit(null); } }} /> % overall</span>
                  : <button className="fx-overall-edit" onClick={() => setOverallEdit(String(sub.match))} title="Adjust overall match %"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>Adjust %</button>}
              </div>
              {fromNote > 0 && (
                <div style={{ marginTop: 5, fontSize: 12, fontWeight: 600, color: '#a82451', display: 'inline-flex', alignItems: 'center', gap: 5 }} title="These concerns came from the board's free-text, not the pain-point checkboxes — a read on how much the “in their own words” field is earning its keep.">
                  <I.Sparkle width={12} height={12} /> {fromNote} of {sub.concerns.length} surfaced from what they wrote
                </div>
              )}
            </div>
            <button className="v2-engine-btn" onClick={() => setShowEngine(true)}>
              <span className="v2-eng-pulse" aria-hidden="true"><span className="ring" /><span className="ring r2" /><span className="dot" /></span>
              Open Engine Map
            </button>
          </div>
          <div className="v2-match-list">
            {sub.concerns.map((c, i) => <MatchConcern key={sub.id + i} concern={c} uvps={camTitles()} blurbs={camBlurbs()} index={i + 1}
              onEdit={() => setConcernEdit(i)}
              onRemove={() => onApplyMatch(sub.concerns.filter((_, k) => k !== i), sub.match)} />)}
          </div>
          <button className="fx-add-concern" onClick={() => setConcernEdit('new')}><I.Plus width={14} height={14} /> Add a concern</button>
          {concernEdit != null && (
            <ConcernEditModal
              concern={concernEdit === 'new' ? null : sub.concerns[concernEdit]}
              onClose={() => setConcernEdit(null)}
              onSave={(updated) => onApplyMatch(concernEdit === 'new' ? [...sub.concerns, updated] : sub.concerns.map((c, k) => (k === concernEdit ? updated : c)), sub.match)}
            />
          )}
        </div>

        <div className="v2-ctx">
          <div className="v2-card">
            <div className="v2-ctx-name">{sub.community}</div>
            <div className="v2-ctx-id">{sub.id}</div>
            <div className="v2-ctx-rows">
              <div className="v2-ctx-row"><span className="v2-ctx-k">Contact</span><span className="v2-ctx-v">{sub.contact} · {sub.contactRole}</span></div>
              <div className="v2-ctx-row"><span className="v2-ctx-k">Email</span><span className="v2-ctx-v">{sub.email}</span></div>
              <div className="v2-ctx-row"><span className="v2-ctx-k">Phone</span><span className="v2-ctx-v">{sub.phone}</span></div>
              <div className="v2-ctx-row"><span className="v2-ctx-k">Type</span><span className="v2-ctx-v">{sub.metaType}</span></div>
              <div className="v2-ctx-row"><span className="v2-ctx-k">Homes</span><span className="v2-ctx-v">{sub.homes}</span></div>
              <div className="v2-ctx-row"><span className="v2-ctx-k">Status</span><span className="v2-ctx-v">{sub.metaStatus}</span></div>
              <div className="v2-ctx-row"><span className="v2-ctx-k">Dues</span><span className="v2-ctx-v">{sub.dues}</span></div>
              <div className="v2-ctx-row"><span className="v2-ctx-k">Timeline</span><span className="v2-ctx-v">{sub.engageTimeline}</span></div>
              <div className="v2-ctx-row full"><span className="v2-ctx-k">Budget</span><span className="v2-ctx-v">{sub.budget}</span></div>
              {/* Both of these were mapped at intake and then discarded — no column,
                  no read, nowhere on screen. `services` is now what decides the
                  recommended tier, so a CAM has to be able to see the answer it was
                  derived from; amenities is simply information the board gave us
                  that nobody could read. Rendered only when present, so older
                  leads (and postcard-landing leads, which have neither) are
                  unchanged rather than showing empty rows. */}
              {sub.services ? <div className="v2-ctx-row full"><span className="v2-ctx-k">Services asked for</span><span className="v2-ctx-v">{sub.services}</span></div> : null}
              {sub.amenities ? <div className="v2-ctx-row full"><span className="v2-ctx-k">Amenities</span><span className="v2-ctx-v">{sub.amenities}</span></div> : null}
            </div>
            <div className="v2-ctx-quote"><div className="v2-ctx-quote-k">In their words</div><div className="v2-quote">"{sub.quote}"</div></div>
          </div>
          <div className="v2-card">
            <div className="v2-tier-eyebrow">Recommended tier</div>
            <div className="v2-tier-name">{sub.tierName}</div>
            {/* The number is never unattributable: say which answer chose it. */}
            {sub.tierRec?.why ? <div className="v2-tier-why">{sub.tierRec.why}</div> : null}
            <div className="v2-tier-price">{pr.monthly}<small> /mo</small></div>
            <div className="v2-tier-breakdown">
              <div className="v2-tier-brow"><span className="v2-tier-bk">Per home</span><span className="v2-tier-bv">{pr.perHome}</span></div>
              <div className="v2-tier-brow"><span className="v2-tier-bk">Homes</span><span className="v2-tier-bv">{sub.homes}</span></div>
              <div className="v2-tier-brow"><span className="v2-tier-bk">Billed annually</span><span className="v2-tier-bv">{pr.annual}</span></div>
            </div>
            <div className="v2-tier-foot">No setup fee</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================ BUILD ============================

// The pinned lead card — a compact header that pins below the stepper and travels
// across stages, swapping its status pill + 3 figures by where the lead is. In
// Build it replaces the old purple topper and owns price editing (Proposed fig).
function PinnedCard({ sub, stage, perHome, setPerHome, onEdit, onOpenFull, cta }) {
  const [edit, setEdit] = useState(false);
  // Through pricing() so the tier minimum applies. Raw perHome * homes here was
  // the headline that showed "$48.00/mo" for a 12-home community.
  const monthly = pricing(sub, perHome).monthlyNum;
  const STATUS = { new: 'New · unworked', build: 'Building', sent: 'Sent', won: 'Won', lost: 'Lost' };
  const ownerFig = sub.owner
    ? { k: 'Owner', v: <><span className="av">{sub.owner}</span>{ownerFirstOf(sub.owner)}</> }
    : { k: 'Owner', v: 'Unassigned' };
  // A row demoted out of Sent keeps its sent_at, so say so rather than letting
  // Build/New present a previously-emailed proposal as untouched.
  let figs, statusText = STATUS[stage] + (sub.sentAt && (stage === 'new' || stage === 'build') ? ' · previously sent' : '');
  if (stage === 'sent') {
    const w = getWatch(sub), pr = pricing(sub);
    statusText = 'Sent · ' + ((w.heat || 'cold').charAt(0).toUpperCase() + (w.heat || 'cold').slice(1));
    figs = [{ k: 'Opens', v: w.opens, hot: w.heat === 'hot' }, { k: 'Viewers', v: w.viewers.length }, { k: 'Value', v: pr.monthly + '/mo' }];
  // NB: there is no won/lost branch. PinnedCard is only mounted with stage
  // new | sent | build (see its three call sites), and the old won/lost branch
  // labelled ANNUAL stored money (salesValue/quoteValue) as '/mo' — a wrong
  // number in a view nobody rendered. Removed rather than fixed; if a focused
  // Won/Lost view is ever built, price it through pricing() and label /yr.
  } else {
    figs = [{ k: 'Match', v: sub.match + '%' }, ownerFig, { k: 'Proposed', edit: true }];
  }
  return (
    <div className="fx-pin">
      <div className="fx-pin-l">
        <div className="fx-pin-name">{sub.community}<span className="fx-pin-status" data-s={stage}>{statusText}</span></div>
        <div className="fx-pin-meta">{sub.contact}{sub.contactRole ? ' · ' + sub.contactRole : ''} · {sub.homes} homes · {sub.city}</div>
      </div>
      <div className="fx-pin-figs">
        {figs.flatMap((f, i) => [
          i > 0 ? <div className="fx-pin-divider" key={'d' + i} /> : null,
          <div className="fx-pin-fig" key={f.k}>
            <span className="k">{f.k}</span>
            {f.edit
              ? (edit
                ? <span className="v edit"><span>$</span><input type="number" step="0.01" min="0" value={perHome} autoFocus onChange={(e) => setPerHome(parseFloat(e.target.value) || 0)} onBlur={() => setEdit(false)} onKeyDown={(e) => e.key === 'Enter' && setEdit(false)} /></span>
                : <button className="v edit" onClick={() => setEdit(true)} title="Edit price">{fmtMoney(monthly)}/mo <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button>)
              : <span className={'v' + (f.hot ? ' hot' : '')}>{f.v}</span>}
          </div>,
        ])}
      </div>
      {(onEdit || onOpenFull) && (
        <div className="fx-pin-acts">
          {onOpenFull && (
            <button className="fx-pin-edit" onClick={onOpenFull} title="Open the full proposal in a new tab">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14 21 3" /></svg>
              Open full proposal
            </button>
          )}
          {onEdit && (
            <button className="fx-pin-edit" onClick={onEdit} title="Edit lead details">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
              Edit
            </button>
          )}
        </div>
      )}
      {cta && <button className="fx-pin-cta" onClick={cta.onClick}>{cta.label} <span>→</span></button>}
    </div>
  );
}

function ClSection({ s, toggle, onEdit }) {
  return (
    <div className="v2-cl">
      <div className="v2-cl-main" onClick={() => !s.required && toggle(s.id)}>
        <span className="v2-cl-check" data-on={s.on}>{s.on && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}</span>
        <div className="v2-cl-info"><div className="v2-cl-t">{s.title}</div><div className="v2-cl-n">{s.required ? 'Required' : s.note}</div></div>
        {s.editable && (
          <button className="v2-cl-pencil" title="Edit text" onClick={(e) => { e.stopPropagation(); onEdit(s.id); }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}

// A concern row in the Build checklist — toggle whether it's in the proposal,
// edit its text, or remove it. All three persist through onApplyMatch (the same
// match_snapshot path as the New stage), so the live preview reflects them.
function ClConcern({ concern, onToggle, onEdit, onRemove }) {
  const on = concern.on !== false;
  const caps = (concern.caps || []).length;
  return (
    <div className="v2-crow" data-off={!on} onClick={onToggle}>
      <span className="v2-chk">{on && <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>}</span>
      <div className="v2-crow-main">
        <div className="v2-crow-title">{concern.label}</div>
        <div className="v2-crow-meta">
          <span className="v2-fitchip">{concern.fit || 0}% fit</span>
          <span className="v2-crow-cap">{caps} matched cap{caps === 1 ? '' : 's'}</span>
          <div className="v2-crow-acts">
            <button className="v2-crow-act" title="Edit concern" onClick={(e) => { e.stopPropagation(); onEdit(); }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button>
            <button className="v2-crow-act danger" title="Remove concern" onClick={(e) => { e.stopPropagation(); onRemove(); }}><I.Close width={13} height={13} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Non-editable structural section — always part of every proposal. Reads as a
// locked, fixed row (the "Always included" tag lives once on the zone divider).
function ClFixed({ s }) {
  return (
    <div className="v2-srow">
      <span className="v2-lock" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg></span>
      <div className="v2-srow-main"><div className="v2-srow-title">{s.title}</div><div className="v2-srow-note">{s.note}</div></div>
    </div>
  );
}

// Build sidebar — two zones (handoff #26). Zone 1: the matched concerns the admin
// curates (toggle / edit / remove), in a tinted green card. Zone 2: the fixed
// standard sections, locked, under a single "Always included" divider. Ordered by
// type (decision surface leads), not document order.
function BuildChecklist({ sub, sections, toggle, perHome, setPerHome, onApplyMatch }) {
  const [concernEdit, setConcernEdit] = useState(null); // index | 'new' | null
  const concerns = sub.concerns || [];
  const onCount = concerns.filter((c) => c.on !== false).length;
  const standard = sections.filter((s) => !s.id.startsWith('pain')); // cover + fixed sections
  return (
    <div className="v2-checklist">
      <div className="v2-checklist-head">
        <div className="t">Sections</div>
        <div className="s">{concerns.length} concern{concerns.length === 1 ? '' : 's'} matched to their intake, plus {standard.length} section{standard.length === 1 ? '' : 's'} every proposal includes.</div>
      </div>
      <div className="v2-cl-list two-zone">
        {/* Zone 1 — matched concerns (the curated surface) */}
        <div className="v2-zone-c">
          <div className="v2-zone-c-lbl"><span className="l">Matched concerns</span><span className="r">{onCount} of {concerns.length} on</span></div>
          {concerns.map((cc, i) => (
            <ClConcern key={sub.id + '-c' + i} concern={cc}
              onToggle={() => onApplyMatch(concerns.map((x, k) => (k === i ? { ...x, on: x.on === false } : x)), sub.match)}
              onEdit={() => setConcernEdit(i)}
              onRemove={() => onApplyMatch(concerns.filter((_, k) => k !== i), sub.match)} />
          ))}
          <button className="v2-addc" onClick={() => setConcernEdit('new')}><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg> Add a concern</button>
        </div>
        {/* Zone 2 — standard sections (fixed scaffolding) */}
        <div className="v2-grp"><span>Standard sections</span><span className="ln" /><span>Always included</span></div>
        <div>
          {standard.map((s) => <ClFixed key={s.id} s={s} />)}
        </div>
      </div>
      {concernEdit != null && (
        <ConcernEditModal
          concern={concernEdit === 'new' ? null : concerns[concernEdit]}
          onClose={() => setConcernEdit(null)}
          onSave={(updated) => onApplyMatch(concernEdit === 'new' ? [...concerns, { ...updated, on: true }] : concerns.map((c, k) => (k === concernEdit ? { ...c, ...updated } : c)), sub.match)} />
      )}
    </div>
  );
}

function BuildStage({ sub, sections, toggle, perHome, setPerHome, onApplyMatch, previewNonce, onContinue, live }) {
  // Live preview = the real board-facing proposal page in an iframe (so its
  // fixed accept/decline bar and full styling render in isolation). It's the
  // selected lead's CMGT-branded document at /proposals/board/:id. previewNonce
  // bumps after a concern edit so the iframe re-fetches the persisted change.
  // In live mode the board page can ONLY resolve a board_token, so a row without
  // one has no previewable URL — rendering the iframe anyway is what produced the
  // "invalid or has expired" page and read as a broken proposal rather than a
  // missing token. Mock dev has no tokens at all and resolves the lead id locally.
  const previewUrl = (!live || sub.boardToken) ? BOARD_URL(sub) : null;
  return (
    <div className="v2-build">
      <BuildChecklist sub={sub} sections={sections} toggle={toggle} perHome={perHome} setPerHome={setPerHome} onApplyMatch={onApplyMatch} />
      <div className="v2-browser">
        <div className="v2-browser-bar">
          <div className="v2-dots"><span /><span /><span /></div>
          <div className="v2-url"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>{cam().contact.web}/p/{sub.id.toLowerCase()}</div>
          <span className="v2-browser-live"><span className="d" />Live preview</span>
        </div>
        <div className="v2-browser-body">
          {previewUrl ? (
            <iframe key={previewNonce} className="v2-board-iframe" src={`${previewUrl}?r=${previewNonce}`} title="Live proposal preview — what the board sees" />
          ) : (
            <div className="v2-board-pending">
              <b>Preparing the secure board link</b>
              <span>This proposal's link hasn't come back from the database yet. Reload the page to see the preview — the document itself is fine and sending is unaffected.</span>
            </div>
          )}
        </div>
        <div className="v2-browser-foot">
          <span className="v2-browser-foot-note">This is the live, interactive proposal — exactly what {sub.firstName} sees. <b>Send proposal</b> and <b>Open full proposal</b> are up top on the lead card.</span>
        </div>
      </div>
    </div>
  );
}

// ============================ SEND ============================
// In-cockpit mirror of the real board email (proposal-send / handoff #20), so
// the Send preview matches what the board actually receives.
const EML = { brand: '#2b2c6c', navy: '#1a1b4a', accent: '#2f9e6f', ink: '#1b1430', body: '#57506a', muted: '#8a8395', hairline: '#e9e5f0', tint: '#f7f5fb', checkBg: '#e4f3ec' };
function NewEmailPreview({ sub }) {
  const FD = 'Arial,Helvetica,sans-serif', FB = FD; // match the real (Arial) email
  const priorities = (sub.concerns || []).filter((c) => c.on !== false).map((c) => c.label).slice(0, 6);
  const nWord = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][priorities.length] || String(priorities.length);
  const cell = (k, v, s2, i) => (
    <div key={k} style={{ padding: '12px 14px', borderLeft: i ? `1px solid ${EML.hairline}` : 'none' }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: EML.muted }}>{k}</div>
      <div style={{ fontFamily: FD, fontSize: 14, fontWeight: 700, color: EML.ink, marginTop: 4, lineHeight: 1.2 }}>{v}</div>
      <div style={{ fontSize: 11, color: EML.muted, marginTop: 3 }}>{s2}</div>
    </div>
  );
  return (
    <div style={{ background: '#fff', borderRadius: 14, overflow: 'hidden', border: `1px solid ${EML.hairline}`, fontFamily: FB }}>
      <div style={{ background: EML.brand, padding: '18px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontFamily: FD, fontWeight: 700, fontSize: 17, letterSpacing: '.04em', color: '#fff' }}>{cam().shortName}</span>
        <span style={{ fontFamily: FD, fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: '#aab0e0' }}>{cam().tagline}</span>
      </div>
      <div style={{ background: EML.navy, padding: '34px 26px 32px', color: '#fff' }}>
        <div style={{ fontFamily: FD, fontSize: 10, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, color: '#c8ccf0' }}><span style={{ width: 20, height: 3, background: EML.accent, display: 'inline-block' }} />Your management proposal</div>
        <div style={{ fontFamily: FD, fontWeight: 700, fontSize: 28, lineHeight: 1.08, letterSpacing: '-.01em' }}>Built around {sub.community}.</div>
        <div style={{ fontFamily: FD, fontSize: 13, color: '#b9bce0', marginTop: 11 }}>Prepared for {sub.contact || sub.firstName} &amp; the board.</div>
      </div>
      <div style={{ padding: '20px 24px 4px' }}>
        <div style={{ fontFamily: FD, fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: EML.accent, marginBottom: 9 }}>Here's what you told us</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', border: `1px solid ${EML.hairline}`, borderRadius: 10 }}>
          {cell('Community', sub.community, sub.city || '—', 0)}
          {cell('Homes', String(sub.homes || '—'), 'units under management', 1)}
          {cell('Type', sub.metaType || '—', sub.metaStatus || '', 2)}
        </div>
      </div>
      <div style={{ padding: '20px 24px 4px' }}>
        <div style={{ fontFamily: FD, fontWeight: 700, fontSize: 15, color: EML.ink, marginBottom: 9 }}>Hi {sub.firstName},</div>
        <div style={{ fontSize: 14, lineHeight: 1.6, color: EML.body }}>Thank you for telling us about <b style={{ color: EML.ink }}>{sub.community}</b>. We didn't send a generic pitch — we built this proposal around {priorities.length ? <>the <b style={{ color: EML.ink }}>{nWord} priorities your board raised</b>, point by point</> : 'the specific priorities your board raised'}.</div>
      </div>
      {priorities.length > 0 && (
        <div style={{ padding: '18px 24px 4px' }}>
          <div style={{ borderTop: `1px solid ${EML.hairline}`, paddingTop: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: EML.muted, marginBottom: 9 }}>The priorities we answered</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
              {priorities.map((p, i) => (<div key={i} style={{ display: 'flex', gap: 9, fontSize: 13, color: EML.ink, lineHeight: 1.4 }}><span style={{ width: 18, height: 18, flex: 'none', borderRadius: 999, background: EML.checkBg, color: EML.accent, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800 }}>✓</span>{p}</div>))}
            </div>
          </div>
        </div>
      )}
      <div style={{ padding: '22px 24px 6px' }}>
        <a href={BOARD_URL(sub)} target="_blank" rel="noopener" onClick={(e) => { e.preventDefault(); window.open(BOARD_URL(sub), '_blank', 'noopener'); }} style={{ display: 'block', background: EML.accent, color: '#fff', fontFamily: FD, fontSize: 15, fontWeight: 700, textAlign: 'center', textDecoration: 'none', padding: '15px 26px', borderRadius: 11 }}>View your proposal →</a>
      </div>
      <div style={{ padding: '12px 24px 4px' }}>
        <div style={{ background: EML.tint, borderRadius: 10, padding: '12px 14px', display: 'flex', gap: 10, fontSize: 12, lineHeight: 1.5, color: EML.muted }}><span aria-hidden="true">🔒</span><span><b style={{ color: EML.body }}>One-tap secure link — no password.</b> It signs you in automatically and works only from this email.</span></div>
      </div>
      <div style={{ padding: '16px 24px 22px' }}>
        <div style={{ fontFamily: FD, fontWeight: 700, fontSize: 14, color: EML.ink }}>— The {cam().shortName} team</div>
        <div style={{ fontSize: 12, color: EML.muted, marginTop: 2 }}>Client Partnerships · {cam().shortName}</div>
      </div>
    </div>
  );
}

// The placeholder-price acknowledgement, shared by every path that emails a
// board: send, nudge and resend. It used to exist only on the first send, so an
// acknowledged proposal could then be re-sent any number of times without being
// re-asked — and nudge lets staff type free text, where someone could write
// "$100/mo as agreed" into a message.
function ProvisionalPriceAck({ sub, checked, onChange }) {
  const pr = pricing(sub);
  if (!pr.provisional) return null;
  return (
    <div className="fx-flags" style={{ margin: '0 0 14px' }}>
      <div className="fx-flag">
        <span className="fx-flag-ic" aria-hidden="true">!</span>
        <div>
          <div className="fx-flag-t">This price uses a placeholder minimum</div>
          <div className="fx-flag-s">
            {sub.homes} {sub.homes === 1 ? 'home' : 'homes'} at {pr.perHome}/home is {pr.rawMonthly}/mo, so the{' '}
            <b>{money(pr.minimum)}/mo minimum</b> is used instead — a stand-in, not a rate CMGT has confirmed.
            The board will see <b>{pr.monthly}/mo</b>.
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 9, fontWeight: 700, color: '#7a5a12', cursor: 'pointer' }}>
              <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
              <span>I've confirmed {pr.monthly}/mo is the right number to quote.</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
// True when this proposal may not be emailed without an explicit confirmation.
const needsPriceAck = (sub) => !!pricing(sub).provisional;

function MomentOfTruth({ sub, onSend }) {
  // Recipient is editable so you can send a test to yourself (the demo boards
  // have placeholder emails). For real leads it defaults to the board contact.
  const [to, setTo] = useState(sub.email || '');
  // A PROVISIONAL minimum is a number nobody has agreed to. It must not reach a
  // board on the strength of a warning nobody read, so sending is blocked until
  // staff ticks it. Only appears when an invented floor actually set the price.
  const needsAck = needsPriceAck(sub);
  const [ack, setAck] = useState(false);
  return (
    <div className="v2-send-step" style={{ padding: '20px 24px 24px' }}>
      <ProvisionalPriceAck sub={sub} checked={ack} onChange={setAck} />
      <div className="v2-preview-bar">
        <span className="v2-preview-av v2-mail-av"><I.Send width={17} height={17} /></span>
        <div className="v2-preview-id">
          <div className="t">The email {sub.firstName} receives</div>
          <div className="s">From {cam().shortName} · a one-tap magic link to the live proposal</div>
        </div>
        <div className="grow" />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>Send to</span>
          <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="board@email.com"
            style={{ padding: '9px 11px', borderRadius: 9, border: '1px solid var(--border, #d9d6e0)', fontSize: 13, minWidth: 230, fontFamily: 'inherit' }} />
        </label>
        <button className="v2-mail-send" disabled={!to.trim() || (needsAck && !ack)}
          title={needsAck && !ack ? 'Confirm the placeholder minimum price first' : undefined}
          onClick={() => onSend(to.trim())}><span className="v2-mail-send-ic"><I.Send width={18} height={18} /></span>Send proposal</button>
      </div>
      <div className="v2-mail" style={{ maxWidth: 600, margin: '0 auto', width: '100%' }}>
        <div className="v2-mail-toolbar">
          <span className="v2-mail-app"><span className="dot" /> Mail · Inbox</span>
          <div className="grow" />
          <div className="v2-mail-tools">
            <button title="Archive"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></svg></button>
            <button title="Reply"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 17l-5-5 5-5M4 12h11a4 4 0 0 1 4 4v2" /></svg></button>
            <button title="Delete"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" /></svg></button>
          </div>
        </div>
        <div className="v2-mail-headrow">
          <h3 className="v2-mail-subject">Built around {sub.community} — your management proposal</h3>
          <div className="v2-mail-meta">
            <span className="v2-mail-sender-av">A</span>
            <div className="v2-mail-who"><div className="from">{cam().emailFromName} <span className="addr">{`<${cam().contact.email}>`}</span></div><div className="to">to {sub.firstName} ▾</div></div>
            <div className="v2-mail-time">now</div>
          </div>
        </div>
        <div className="v2-mail-body">
          <NewEmailPreview sub={sub} />
        </div>
      </div>
    </div>
  );
}

function LaunchOverlay({ sub }) {
  return (
    <div className="v2-launch">
      <div className="v2-launch-card">
        <LottieScan data={sendingMailData} size={132} className="v2-launch-scan" />
        <div className="v2-launch-txt">Sending to {sub.firstName}…</div>
        <div className="v2-launch-sub">{sub.email}</div>
      </div>
    </div>
  );
}

function SentScreen({ sub, onPreview, onTrack, onBack }) {
  const pr = pricing(sub);
  return (
    <div className="v2-sent">
      <div className="v2-sent-ic"><I.Send width={30} height={30} /></div>
      <h2 className="v2-sent-h">Proposal sent to {sub.firstName}.</h2>
      <p className="v2-sent-sub">{sub.community} will get a secure link to the live proposal. It's now marked <b>Sent</b> in your queue, and we'll notify you the moment {sub.firstName} opens it.</p>
      <div className="v2-sent-card">
        <div className="v2-sent-row"><span className="k">Sent to</span><span className="v">{sub.contact} · {sub.email}</span></div>
        <div className="v2-sent-row"><span className="k">Community</span><span className="v">{sub.community} · {sub.homes} homes</span></div>
        <div className="v2-sent-row"><span className="k">Recommended tier</span><span className="v">{sub.tierName} · {pr.monthly}/mo</span></div>
        <div className="v2-sent-row"><span className="k">Secure link</span><span className="v">Expires in 14 days · magic link</span></div>
      </div>
      <div className="v2-sent-actions">
        <button className="btn btn-secondary" onClick={onPreview}><I.Search width={14} height={14} /> Preview as {sub.firstName}</button>
        <button className="btn btn-primary" onClick={onTrack}><I.TrendUp width={14} height={14} /> Track engagement</button>
        <button className="btn btn-secondary" onClick={onBack}>Back to queue</button>
      </div>
    </div>
  );
}

// ============================ CLOSE (engagement analytics) ============================
const HEAT = {
  hot: { label: 'Hot', cls: 'hot', hint: 'Actively reading · follow up now' },
  warm: { label: 'Warm', cls: 'warm', hint: 'Engaged · keep it moving' },
  cold: { label: 'Cold', cls: 'cold', hint: 'Going quiet · time to nudge' },
  new: { label: 'Just sent', cls: 'new', hint: 'Awaiting first open' },
};
const HEAT_RANK = { hot: 0, warm: 1, new: 2, cold: 3 };
const getWatch = (s) => s.watch || freshWatch(s);
function expState(w) {
  const frac = w.linkLife ? w.daysLeft / w.linkLife : 1;
  const cls = w.daysLeft <= 7 ? 'soon' : frac <= 0.4 ? 'mid' : 'ok';
  return { frac: Math.max(frac, 0.03), cls, label: w.daysLeft <= 0 ? 'Expired' : w.daysLeft + (w.daysLeft === 1 ? ' day left' : ' days left') };
}
function HeatPill({ heat, big }) { const h = HEAT[heat] || HEAT.cold; return <span className={'v2-w-heat v2-w-heat--' + h.cls + (big ? ' big' : '')}><span className="d" />{h.label}</span>; }
function ExpBar({ w }) { const e = expState(w); return <span className="v2-w-mini"><span className={'v2-w-mini-fill exp-' + e.cls} style={{ width: e.frac * 100 + '%' }} /></span>; }

// A nudge is the CAM's own words, not a template: `msg` is what actually
// renders as the email body (proposal-send nudge mode), so it must be threaded
// through onSend — dropping it is how the typed message used to vanish.
// Resend re-emails the existing magic link with one click and no modal, so when
// the price is a placeholder there is nowhere to confirm it. This is that step.
function ResendModal({ s, onClose, onResend }) {
  const [ack, setAck] = useState(false);
  const needsAck = needsPriceAck(s);
  return (
    <div className="ps-scrim" onClick={onClose}>
      <div className="ps-modal v2-qual-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ps-modal-head">
          <span className="t">Resend to {s.firstName}</span>
          <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600 }}>{s.email}</span>
          <button className="x" onClick={onClose} aria-label="Close"><I.Close width={15} height={15} /></button>
        </div>
        <div className="v2-qual-body">
          <ProvisionalPriceAck sub={s} checked={ack} onChange={setAck} />
          <div className="v2-qual-hint">Re-emails the same secure link to the address on the proposal. Engagement already
            recorded is kept — this does not reset the tracking window.</div>
          <div className="v2-qual-actions">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={needsAck && !ack}
              onClick={() => { onResend(s); onClose(); }}><I.Send width={14} height={14} /> Resend</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NudgeModal({ s, onClose, onSend }) {
  const w = getWatch(s);
  const [msg, setMsg] = useState(`Hi ${s.firstName},\n\nJust checking in on the proposal for ${s.community}. Happy to walk the board through any section — pricing, the 90-day onboarding, or how we mapped your concerns — on a quick call whenever works.\n\n— ${ownerFirstOf(s.owner)}`);
  const [ccRaw, setCcRaw] = useState('');
  const cc = parseCcInput(ccRaw);
  // A nudge emails free-typed text about a proposal whose price may be a
  // placeholder, so it needs the same confirmation as the original send.
  const needsAck = needsPriceAck(s);
  const [ack, setAck] = useState(false);
  const canSend = !!msg.trim() && cc.ok && !cc.overflow && (!needsAck || ack);
  return (
    <div className="ps-scrim" onClick={onClose}>
      <div className="ps-modal v2-qual-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ps-modal-head">
          <span className="t">Nudge · {s.firstName}</span>
          <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 600 }}>Last opened {w.lastOpened}</span>
          <button className="x" onClick={onClose}><I.Close width={15} height={15} /></button>
        </div>
        <div className="v2-qual-body">
          <ProvisionalPriceAck sub={s} checked={ack} onChange={setAck} />
          <label className="v2-qual-label">Follow-up message <span>· to {s.contact}</span></label>
          <textarea className="v2-edit-area" style={{ minHeight: 150 }} value={msg} onChange={(e) => setMsg(e.target.value)} autoFocus />
          <label className="v2-qual-label">CC <span>· optional — other board members</span></label>
          <input className="v2-qual-input" type="text" value={ccRaw} placeholder="treasurer@oakgrovehoa.org, president@…"
            onChange={(e) => setCcRaw(e.target.value)} data-bad={!cc.ok || cc.overflow} />
          <div className="v2-qual-hint">
            {!cc.ok
              ? <span className="v2-qual-bad">Not a valid email: {cc.invalid.join(', ')}</span>
              : cc.overflow
                ? <span className="v2-qual-bad">{cc.list.length} addresses — CC is capped at {CC_MAX}.</span>
                : <>Sends as a reply on the original thread, with the same secure link.{cc.list.length ? ` Copying ${cc.list.length} other ${cc.list.length === 1 ? 'person' : 'people'}.` : ''}</>}
          </div>
          <div className="v2-qual-actions">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={!canSend}
              onClick={() => { onSend(s, { message: msg, cc: cc.list }); onClose(); }}><I.Send width={14} height={14} /> Send nudge</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LeadList({ open, selectedId, onPick }) {
  return (
    <aside className="v2-w-list">
      <div className="v2-w-list-head"><span className="t">Open proposals</span><span className="c">{open.length}</span></div>
      <div className="v2-w-list-rows">
        {open.map((s) => {
          const w = getWatch(s), e = expState(w);
          return (
            <button className="v2-w-row" key={s.id} data-heat={w.heat} data-active={s.id === selectedId} onClick={() => onPick(s.id)}>
              <div className="v2-w-row-top"><span className={'v2-w-row-dot h-' + w.heat} /><span className="v2-w-row-name">{s.community}</span><span className="v2-w-row-opens">{w.opens}<span className="u">{w.opens === 1 ? ' open' : ' opens'}</span></span></div>
              <div className="v2-w-row-meta">{s.contact} · {s.homes} homes</div>
              <div className="v2-w-row-exp"><ExpBar w={w} /><span className={'v2-w-row-exp-lbl exp-' + e.cls}>{e.label}</span></div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

// The board's latest explicit response (from the board page modals), surfaced
// at the top of Close so staff act on it at a glance.
function ResponseBanner({ r }) {
  if (!r) return null;
  const cfg = {
    continue: { bg: '#eafaf1', bd: '#bfe6cf', fg: '#1f7a44', Ic: I.Check, title: r.meta && r.meta.method === 'email' ? 'Board asked to connect by email' : 'Board is moving forward' },
    changes: { bg: '#fdf5e6', bd: '#f0ddb0', fg: '#9a6b12', Ic: I.Edit, title: 'Board requested changes' },
    decline: { bg: '#f3f3f6', bd: '#e0dee6', fg: '#6b6675', Ic: I.Close, title: 'Board declined' },
  }[r.action];
  if (!cfg) return null;
  const m = r.meta || {};
  const detail = r.action === 'continue' ? (m.slot ? `Discovery call · ${m.slot}` : 'Wants to connect by email')
    : r.action === 'changes' ? [(m.areas || []).join(', '), m.specifics].filter(Boolean).join(' — ')
    : [m.reason, m.notes].filter(Boolean).join(' — ');
  return (
    <div className="v2-w-response" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', background: cfg.bg, border: `1px solid ${cfg.bd}`, borderRadius: 12, padding: '13px 15px', marginBottom: 14 }}>
      <span style={{ width: 26, height: 26, borderRadius: 999, background: cfg.fg, color: '#fff', display: 'grid', placeItems: 'center', flex: 'none' }}><cfg.Ic width={14} height={14} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 13.5, color: cfg.fg }}>{cfg.title}<span style={{ fontWeight: 600, color: 'var(--fg-muted)', fontSize: 11.5 }}> · {r.when}</span></div>
        {detail && <div style={{ fontSize: 12.5, color: 'var(--fg)', marginTop: 3, lineHeight: 1.45 }}>{detail}</div>}
      </div>
    </div>
  );
}

// These numbers describe ONE send. A proposal can be sent, demoted, reworked and
// sent again, and proposal_events keeps appending — so whenever earlier rounds
// were excluded, say so rather than letting the figures read as all-time.
function SendRoundTag({ w }) {
  const r = w && w.round;
  if (!r || !r.priorEvents) return null;
  return (
    <div className="v2-qual-warn" style={{ marginBottom: 12 }}>
      <b>This send only.</b> Everything below is engagement since the proposal was last sent
      {r.since ? <> on {fmtReceived(Date.parse(r.since))}</> : null}.
      {' '}<b>{r.priorEvents}</b> earlier {r.priorEvents === 1 ? 'event' : 'events'}
      {r.priorOpens ? <> (including {r.priorOpens} {r.priorOpens === 1 ? 'open' : 'opens'})</> : null}
      {' '}from a previous send {r.priorEvents === 1 ? 'is' : 'are'} still recorded but excluded here.
    </div>
  );
}

function LeadAnalytics({ s, notes, addNote }) {
  const w = getWatch(s), e = expState(w);
  const [note, setNote] = useState('');
  const figs = [
    { k: 'Total opens', v: w.opens, s: w.opens ? 'since sent ' + w.sentOn : 'not opened yet' },
    { k: 'Unique viewers', v: w.viewers.length, s: w.viewers.length ? 'board members' : '—' },
    { k: 'Time reading', v: w.readTime, s: 'all viewers combined' },
    { k: 'Link expires', v: e.label.replace(' left', ''), s: w.daysLeft <= 0 ? 'renew to reopen' : w.expires, exp: e.cls },
  ];
  return (
    <div className="v2-w-detail">
      <SendRoundTag w={w} />
      <ResponseBanner r={w.response} />
      <div className="v2-w-figs">
        {figs.map((f) => (<div className="v2-w-fig" key={f.k} data-exp={f.exp || false}><div className="v2-w-fig-v">{f.v}</div><div className="v2-w-fig-k">{f.k}</div><div className="v2-w-fig-s">{f.s}</div></div>))}
      </div>
      <div className="v2-w-cols">
        <div className="v2-w-colmain">
          <div className="v2-card">
            <div className="v2-block-label">Section engagement · what they read vs. skipped</div>
            <div className="v2-w-secs">
              {w.sections.map((sec, i) => (
                <div className="v2-w-sec" key={i} data-st={sec.status}>
                  <span className="v2-w-sec-dot" />
                  <div className="v2-w-sec-info"><div className="v2-w-sec-name">{sec.name}{sec.note && <span className="v2-w-sec-note">{sec.note}</span>}</div><span className="v2-w-mini"><span className={'v2-w-mini-fill st-' + sec.status} style={{ width: Math.max(sec.pct, 3) + '%' }} /></span></div>
                  <span className="v2-w-sec-pct">{sec.status === 'unseen' ? '—' : sec.pct + '%'}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="v2-card">
            <div className="v2-block-label">Who opened it</div>
            {w.viewers.length === 0 ? (<div className="v2-w-noviewers">No opens yet — the board hasn't viewed this proposal.</div>) : (
              <div className="v2-w-viewers">
                {w.viewers.map((v, i) => (
                  <div className="v2-w-viewer" key={i}><span className="v2-w-viewer-av">{v.initials}</span><div className="v2-w-viewer-id"><div className="nm">{v.name}</div><div className="rl">{v.role}</div></div><div className="v2-w-viewer-stat"><span className="o">{v.opens} {v.opens === 1 ? 'open' : 'opens'}</span><span className="s">last {v.lastSeen}</span></div></div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="v2-w-colside">
          <div className="v2-card">
            <div className="v2-block-label">Activity</div>
            <div className="v2-w-feed-scroll">
              <div className="v2-w-feed">
                {w.feed.map((f, i) => (<div className="v2-w-evt" key={i} data-type={f.type}><span className="v2-w-evt-dot" /><div className="v2-w-evt-body"><div className="v2-w-evt-main">{f.event}{f.detail && <span className="v2-w-evt-tag">{f.detail}</span>}</div><div className="v2-w-evt-meta">{f.who} · {f.when}</div></div></div>))}
              </div>
            </div>
          </div>
          <div className="v2-card">
            <div className="v2-block-label">Internal notes</div>
            {(notes || []).length > 0 && (<div className="v2-w-notes">{notes.map((n, i) => (<div className="v2-w-note" key={i}><div className="v2-w-note-txt">{n.text}</div><div className="v2-w-note-meta">{n.who} · {n.when}</div></div>))}</div>)}
            <textarea className="v2-w-note-in" placeholder="Log a call, a board reaction, next step…" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="v2-w-note-act"><button className="btn btn-primary" disabled={!note.trim()} onClick={() => { addNote(s.id, note.trim()); setNote(''); }}>Add note</button></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Sent · bucket list — every proposal out for signature, with at-a-glance heat +
// engagement. Mirrors the New inbox + Build bucket: a stage holds many.
function SentBucket({ open, onPick }) {
  const hot = open.filter((s) => getWatch(s).heat === 'hot').length;
  return (
    <div>
      <div className="fx-inbox-head">
        <div style={{ minWidth: 0 }}>
          <div className="fx-eyebrow">Live proposals · their court</div>
          <h2 className="fx-h">{open.length} {open.length === 1 ? 'proposal' : 'proposals'} out for signature.</h2>
          <p className="fx-sub">Every proposal you've sent is tracked here. {hot > 0 ? <b>{hot} {hot === 1 ? 'is' : 'are'} hot right now.</b> : 'Nudge the quiet ones before their link expires.'} Open one to see who's reading and how closely.</p>
        </div>
      </div>
      <div className="fx-blist">
        {open.map((s) => {
          const w = getWatch(s), pr = pricing(s);
          return (
            <div className="fx-brow" key={s.id} onClick={() => onPick(s.id)} role="button" tabIndex={0}>
              <div className="fx-brow-l"><div className="fx-brow-nm">{s.community}</div><div className="fx-brow-meta">{s.contact} · {s.homes} homes · {s.city}</div></div>
              <div className="fx-brow-prog">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <HeatPill heat={w.heat} />
                  <span className="fx-brow-proglbl" style={{ marginTop: 0 }}>{w.opens} {w.opens === 1 ? 'open' : 'opens'} · {w.viewers.length} {w.viewers.length === 1 ? 'viewer' : 'viewers'} · last opened {w.lastOpened}</span>
                  {w.round && w.round.priorEvents ? <span className="ps-pill ps-pill--review" title={`Counts this send only. ${w.round.priorEvents} earlier event(s) from a previous send are excluded.`}><span className="d" />This send only</span> : null}
                </div>
              </div>
              <div className="fx-brow-fig"><div className="v">{pr.monthly}/mo</div><div className="k">Value</div></div>
              <button className="fx-brow-go" onClick={(e) => { e.stopPropagation(); onPick(s.id); }}>Open →</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Sent rows the portal never emailed (marked sent by hand). Listed separately and
// WITHOUT heat/opens/expiry, because getWatch() would fall back to freshWatch()
// and invent "Just now - 30 days left - awaiting first open" for every one.
function UntrackedSentBucket({ rows, onPick }) {
  return (
    <div className="v2-card" style={{ marginTop: 14 }}>
      <div className="v2-block-label">Sent outside the portal · {rows.length} · not tracked here</div>
      {rows.map((s) => (
        <div className="fx-brow" key={s.id} onClick={() => onPick(s.id)} role="button" tabIndex={0}>
          <div className="fx-brow-l"><div className="fx-brow-nm">{s.community}</div><div className="fx-brow-meta">{s.contact} · {s.homes} homes · {s.city}</div></div>
          <div className="fx-brow-prog">
            <span className="fx-brow-proglbl" style={{ marginTop: 0 }}>Marked sent by hand — no link was emailed from here, so there is nothing to track.</span>
          </div>
          <div className="fx-brow-fig"><div className="v">{pricing(s).monthly}/mo</div><div className="k">Value</div></div>
          <button className="fx-brow-go" onClick={(e) => { e.stopPropagation(); onPick(s.id); }}>Open →</button>
        </div>
      ))}
    </div>
  );
}

function CloseView({ subs, watchId, setWatchId, onPick, onResend, onNudge, onMove, notesMap, addNote, onEditDetails, onRealign, onOpenFull }) {
  const all = subs.filter((s) => s.status === 'sent');
  // Split before sorting: heat ranking reads getWatch(), which fabricates a
  // "fresh send" for any row with no events. Only portal-sent rows have a real
  // send to rank by.
  const tracked = all.filter((s) => !sentOutsidePortal(s)).sort((a, b) => HEAT_RANK[getWatch(a).heat] - HEAT_RANK[getWatch(b).heat]);
  const untracked = all.filter(sentOutsidePortal);
  if (all.length === 0) {
    return <div className="v2-watch"><div className="v2-w-empty"><span className="ic"><I.Send width={22} height={22} /></span><div className="t">No live proposals yet</div><div className="s">Send a proposal and it'll show up here so you can track every open.</div></div></div>;
  }
  // Nothing focused → the bucket lists (a stage holds many). Pick one → its detail.
  // A stale watchId (the row was just moved out of Sent) falls back to the list
  // rather than silently rendering a DIFFERENT proposal's engagement while the
  // toolbar still edits the moved one.
  if (!watchId || !all.some((s) => s.id === watchId)) {
    return (<>
      {tracked.length > 0 && <SentBucket open={tracked} onPick={onPick} />}
      {untracked.length > 0 && <UntrackedSentBucket rows={untracked} onPick={onPick} />}
    </>);
  }
  const selected = all.find((s) => s.id === watchId);
  return (
    <SentFocus key={selected.id} selected={selected} onBack={() => setWatchId(null)} onResend={onResend} onNudge={onNudge}
      onMove={onMove}
      notes={notesMap[selected.id]} addNote={addNote}
      onEdit={onEditDetails} onRealign={onRealign} onOpenFull={() => onOpenFull(selected)} />
  );
}

// Sent · focused — shared pin header + back-row toolbar (nudge / resend / mark
// won-lost as pills, matching Build), with the engagement detail below.
function SentFocus({ selected, onBack, onResend, onNudge, onMove, notes, addNote, onEdit, onRealign, onOpenFull }) {
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [resendOpen, setResendOpen] = useState(false);
  // Marked sent by hand: the portal never emailed it, so there is nothing to
  // nudge, nothing to track, and no link to resend. Offer the real send instead.
  const untracked = sentOutsidePortal(selected);
  return (
    <div>
      <StageToolbar backLabel="All sent" onBack={onBack} actions={[
        { icon: icoOpen(), label: 'Open full proposal', onClick: onOpenFull },
        { icon: icoEdit(), label: 'Edit details', onClick: onEdit },
        { icon: icoPhone(), label: 'Update from call', onClick: onRealign },
        untracked ? null : { icon: <I.Send width={14} height={14} />, label: 'Send a nudge', onClick: () => setNudgeOpen(true) },
        { icon: icoResend(), label: untracked ? 'Send from the portal' : 'Resend', onClick: () => setResendOpen(true) },
        { icon: icoMove(), label: 'Move / close', onClick: () => onMove(selected), primary: true },
      ]} />
      <PinnedCard sub={selected} stage="sent" />
      {untracked ? <UntrackedSentNotice s={selected} /> : (
        <div className="v2-watch">
          <LeadAnalytics s={selected} notes={notes} addNote={addNote} />
        </div>
      )}
      {nudgeOpen && <NudgeModal s={selected} onClose={() => setNudgeOpen(false)} onSend={onNudge} />}
      {resendOpen && <ResendModal s={selected} onClose={() => setResendOpen(false)} onResend={onResend} />}
    </div>
  );
}

// Sent, but not BY the portal. Deliberately not the engagement panel: getWatch()
// would fall back to freshWatch() and render "sent Just now - 30 days left -
// awaiting first open" for a proposal this system never emailed. Say the true
// thing instead, and offer the one action that makes it trackable.
function UntrackedSentNotice({ s }) {
  return (
    <div className="v2-watch">
      <div className="v2-w-empty">
        <span className="ic"><I.Send width={22} height={22} /></span>
        <div className="t">Sent outside the portal</div>
        <div className="s">
          This was marked sent by hand, so the portal has nothing to track — no opens, no read
          depth, no link countdown. {s.firstName || s.contact} never received a link from here.
          <br /><br />
          Use <b>Send from the portal</b> above to email it properly; engagement tracking starts
          from that moment.
        </div>
      </div>
    </div>
  );
}

// ============================ Stepper + shell ============================
// State-based pipeline stages (each label = WHERE the deal is, not what to do).
// "Send" isn't a stage — it's a button on Build that opens a modal; the deal then
// lands in "Sent" (the engagement/waiting column). Won/Lost is the close fork;
// Client is the retained book of business.
function Stepper({ mode, go }) {
  const order = { new: 0, build: 1, sent: 2, won: 3 };
  const steps = [['new', 'New', 1], ['build', 'Build', 2], ['sent', 'Sent', 3], ['won', 'Won / Lost', 4]];
  const wrapRef = useRef(null);
  const [pill, setPill] = useState({ left: 0, top: 0, w: 0, h: 0 });
  const [glide, setGlide] = useState(false);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const el = wrap.querySelector('.v2-step[data-active="true"]');
    if (el) setPill({ left: el.offsetLeft, top: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    else setPill((p) => ({ ...p, w: 0 }));
  }, [mode]);
  useEffect(() => { const id = requestAnimationFrame(() => setGlide(true)); return () => cancelAnimationFrame(id); }, []);
  return (
    <div className="v2-steps-row">
      <div className="v2-stepper" ref={wrapRef}>
        <span className={'v2-step-pill' + (glide ? ' glide' : '')} style={{ transform: `translateX(${pill.left}px)`, top: pill.top, width: pill.w, height: pill.h }} />
        {steps.map(([id, label, n], i) => {
          const active = mode === id;
          const done = order[mode] > order[id];
          return (
            <React.Fragment key={id}>
              {i > 0 && <span className="v2-step-sep" />}
              <button className="v2-step" data-active={active} data-done={done} onClick={() => go(id)}><span className="num">{done ? '✓' : n}</span>{label}</button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// Start a proposal from a real WhatConverts intake lead. Lists form submissions
// (those with intake fields) that don't yet have a proposal; preview shows what
// the mapper extracted (units, concerns) before you commit.

// Send is an action, not a stage: a modal off Build. Reuses the email-preview +
// recipient screen (MomentOfTruth); its "Send proposal" button fires onSend.
function SendModal({ sub, onClose, onSend }) {
  return (
    <div className="ps-scrim" onClick={onClose}>
      <div className="ps-modal" style={{ maxWidth: 920, width: '100%', maxHeight: '92vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="ps-modal-head"><span className="t">Send proposal to {sub.firstName}</span><button className="x" onClick={onClose} aria-label="Close"><I.Close width={15} height={15} /></button></div>
        <MomentOfTruth sub={sub} onSend={(r) => { onClose(); onSend(r); }} />
      </div>
    </div>
  );
}

// Won / Lost — the closed-outcome stage (accepted vs declined/not-a-fit).
// Remove a lead from the pipeline for good (spam / duplicate / test). Separate
// from QualifyModal's "not quotable": that records a real prospect who didn't
// fit, this hides junk that should never have been a proposal.
const ARCHIVE_REASONS = ['Spam / junk submission', 'Duplicate of another lead', 'Test submission', 'Wrong form / not an HOA', 'Other'];

function ArchiveModal({ s, onClose, onArchive }) {
  const [reason, setReason] = useState(ARCHIVE_REASONS[0]);
  return (
    <div className="ps-scrim" onClick={onClose}>
      <div className="ps-modal v2-qual-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ps-modal-head">
          <span className="t">Remove {s.community}</span>
          <button className="x" onClick={onClose} aria-label="Close"><I.Close width={15} height={15} /></button>
        </div>
        <div className="v2-qual-body">
          <label className="v2-qual-label">Why is it being removed?</label>
          <div className="v2-qual-reasons">
            {ARCHIVE_REASONS.map((r) => (
              <button key={r} className="v2-qual-reason" data-on={reason === r} onClick={() => setReason(r)}>
                <span className="v2-qual-radio" data-on={reason === r} />{r}
              </button>
            ))}
          </div>
          <div className="v2-qual-hint">
            Disappears from every stage — it won't sit in Won / Lost. Intake sync won't bring it back.
            Recoverable from <b>Archive</b> if you need it.
          </div>
          <div className="v2-qual-actions">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn v2-btn-danger" onClick={() => { onArchive(s.id, reason); onClose(); }}>
              <I.Trash width={14} height={14} /> Remove lead
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// The bin. Not a pipeline stage, so it lives off the side rail like UVP Library.
// Permanently delete an archived lead. Irreversible, and it does TWO things —
// the second is not optional: the drain decides what is new by "has no proposal
// row", so deleting the row alone brings the lead straight back on the next
// 3-minute tick. Flagging the lead junk is what actually makes it stay gone, and
// it cleans the submission in WhatConverts instead of only hiding it here.
function DeleteArchivedModal({ rows, onClose, onDelete }) {
  const many = rows.length > 1;
  const [status, setStatus] = useState(junkStatusForReason(rows[0] && rows[0].archivedReason));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await onDelete(rows, status); onClose(); }
    catch (e) { setErr(String((e && e.message) || e)); setBusy(false); }
  };
  return (
    <div className="ps-scrim" onClick={busy ? undefined : onClose}>
      <div className="ps-modal v2-qual-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ps-modal-head">
          <span className="t">Delete {many ? `${rows.length} leads` : rows[0].community || 'this lead'} permanently</span>
          {!busy && <button className="x" onClick={onClose} aria-label="Close"><I.Close width={15} height={15} /></button>}
        </div>
        <div className="v2-qual-body">
          <div className="v2-qual-warn">
            <b>This cannot be undone.</b> {many ? 'These proposals' : 'This proposal'} and any board
            engagement recorded against {many ? 'them' : 'it'} {many ? 'are' : 'is'} deleted outright — not archived.
          </div>
          <div className="v2-qual-warn">
            The {many ? 'leads' : 'lead'} will also be marked <b>{status}</b> in WhatConverts. That is what
            keeps {many ? 'them' : 'it'} gone: intake decides what is new by “has no proposal yet”, so without
            the flag the next sync would simply re-add {many ? 'them' : 'it'}.
          </div>
          <label className="v2-qual-label">Mark the {many ? 'leads' : 'lead'} as</label>
          <div className="v2-qual-reasons">
            {['spam', 'duplicate'].map((r) => (
              <button key={r} className="v2-qual-reason" data-on={status === r} disabled={busy} onClick={() => setStatus(r)}>
                <span className="v2-qual-radio" data-on={status === r} />{r === 'spam' ? 'Spam / junk' : 'Duplicate'}
              </button>
            ))}
          </div>
          {many && (
            <div className="fx-arch-dellist">
              {rows.map((r) => <div key={r.id}>{r.community || 'Unnamed lead'}{r.contact ? ` · ${r.contact}` : ''}</div>)}
            </div>
          )}
          {err && <div className="v2-qual-warn" style={{ borderColor: 'var(--alloy-pink)' }}>Nothing was deleted — {err}</div>}
          <div className="v2-qual-actions">
            <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn v2-btn-danger" onClick={go} disabled={busy}>
              {busy ? 'Deleting…' : `Delete ${many ? rows.length + ' leads' : 'permanently'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ArchiveView({ archived, onRestore, onDelete }) {
  return (
    <div>
      <div className="fx-inbox-head">
        <div style={{ minWidth: 0 }}>
          <div className="fx-eyebrow">Archive · removed from the pipeline</div>
          <h2 className="fx-h">{archived.length} {archived.length === 1 ? 'lead' : 'leads'} removed.</h2>
          <p className="fx-sub">Spam, duplicates and test submissions. These are hidden from every stage and <b>intake sync will not re-add them</b>. Restore one to put it back in the inbox, or delete it for good.</p>
        </div>
        {/* Everything in here was archived deliberately by a human — whatever the
            reason they picked. Scoping the bulk action to "test submission" only
            meant the rows reasoned "Other" had to be deleted one at a time. The
            confirm lists every row before anything happens. */}
        {archived.length > 1 && (
          <button className="btn v2-btn-danger" style={{ flex: 'none' }} onClick={() => onDelete(archived)}>
            Delete all {archived.length} archived
          </button>
        )}
      </div>
      {archived.length === 0 && <div className="fx-empty">Nothing archived — removed leads will collect here.</div>}
      {archived.length > 0 && (
        <div className="fx-arch-list">
          {archived.map((a) => {
            const rms = receivedMs(a);
            return (
              <div className="fx-arch" key={a.id}>
                <div className="fx-arch-main">
                  <div className="fx-arch-t">{a.community || 'Unnamed lead'}</div>
                  <div className="fx-arch-m">
                    {[a.contact, a.homes ? `${a.homes} homes` : '', a.city].filter(Boolean).join(' · ') || 'No contact details'}
                  </div>
                  <div className="fx-arch-m2">
                    {rms != null && <>Received {fmtReceived(rms)} · </>}
                    removed {a.archivedAt ? ageAgo(Date.parse(a.archivedAt)) : ''}{a.archivedBy ? ` by ${a.archivedBy}` : ''}
                  </div>
                </div>
                {a.archivedReason && <span className="fx-arch-why">{a.archivedReason}</span>}
                <button className="fx-arch-restore" onClick={() => onRestore(a.id)}>Restore</button>
                <button className="fx-arch-del" onClick={() => onDelete([a])} title="Delete permanently — also marks the lead junk in WhatConverts so intake never re-adds it">Delete</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WonLostView({ subs, onMove }) {
  // Single-source predicates: the old inline filters counted a disq row with
  // status 'accepted' as BOTH won and lost.
  const won = subs.filter(inWon);
  const lost = subs.filter(inLost);
  const Row = ({ s, kind }) => {
    const pr = pricing(s);
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '13px 15px', border: '1px solid var(--border, #e6e2ee)', borderRadius: 12, background: '#fff', marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--fg)' }}>{s.community}</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 3 }}>{s.contact} · {s.homes} homes · {pr.annual}/yr</div>
        </div>
        <span style={{ fontSize: 11.5, fontWeight: 800, padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap', background: kind === 'won' ? 'var(--alloy-green-tint, #e8f4ec)' : '#f3f1f6', color: kind === 'won' ? '#2f8a5f' : 'var(--fg-muted)' }}>
          {kind === 'won' ? 'Won' : (s.disq ? (s.disqReason || 'Not quotable') : 'Lost')}
        </span>
        {/* Closed used to be a dead end — no control existed on these rows at all,
            so a deal closed by mistake could never be reopened. */}
        <button className="fx-arch-restore" onClick={() => onMove(s)}>Reopen</button>
      </div>
    );
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 14 }}>
      <div className="v2-card">
        <div className="v2-block-label">Won · {won.length}</div>
        {won.length ? won.map((s) => <Row key={s.id} s={s} kind="won" />) : <div style={{ color: 'var(--fg-muted)', fontSize: 13, padding: '8px 2px' }}>No closed-won deals yet.</div>}
      </div>
      <div className="v2-card">
        <div className="v2-block-label">Lost / not a fit · {lost.length}</div>
        {lost.length ? lost.map((s) => <Row key={s.id} s={s} kind="lost" />) : <div style={{ color: 'var(--fg-muted)', fontSize: 13, padding: '8px 2px' }}>None.</div>}
      </div>
    </div>
  );
}

// Layer B — after hand-editing concerns, recompute the caps-derived fields so
// scores / links / capsMatched stay consistent. Overall % stays user-controlled.
function recomputeMatch(concerns, overall, source) {
  const uvps = cam().uvps;
  const n = uvps.length;
  const active = concerns.filter((c) => c.on !== false); // excluded concerns don't count
  const scores = uvps.map((_, i) => active.filter((c) => (c.caps || []).includes(i)).length);
  return {
    match: Math.max(0, Math.min(100, Math.round(overall || 0))),
    concerns, scores, links: concerns.map((c) => c.caps || []),
    capsMatched: scores.filter((s) => s > 0).length, capsTotal: n, _source: source || 'edited',
  };
}

// Layer B — edit one matched concern: its wording, fit %, which UVPs answer it,
// and the proposal prose. The AI's match is a draft; this reshapes it by hand.
function ConcernEditModal({ concern, onClose, onSave }) {
  const c = concern || {};
  const [f, setF] = useState({ label: c.label || '', fit: c.fit != null ? c.fit : 80, headline: c.headline || '', body: c.body || '', caps: [...(c.caps || [])] });
  const toggleCap = (i) => setF((p) => ({ ...p, caps: p.caps.includes(i) ? p.caps.filter((x) => x !== i) : [...p.caps, i] }));
  const save = () => { onSave({ ...c, label: f.label.trim() || 'Untitled concern', fit: Math.max(0, Math.min(100, parseInt(f.fit) || 0)), headline: f.headline, body: f.body, caps: f.caps }); onClose(); };
  return (
    <div className="ps-scrim" onClick={onClose}>
      <div className="ps-modal fx-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ps-modal-head"><span className="t">{concern ? 'Edit concern' : 'Add concern'}</span><button className="x" onClick={onClose} aria-label="Close"><I.Close width={15} height={15} /></button></div>
        <div className="fx-edit-body">
          <label className="fx-ef full"><span className="fx-ef-k">Concern · the board's framing</span><input value={f.label} autoFocus onChange={(e) => setF((p) => ({ ...p, label: e.target.value }))} /></label>
          <label className="fx-ef full"><span className="fx-ef-k">Fit % · how completely your UVPs answer it</span><input type="number" min="0" max="100" value={f.fit} onChange={(e) => setF((p) => ({ ...p, fit: e.target.value }))} /></label>
          <div className="fx-ef full"><span className="fx-ef-k">Which UVPs answer this concern</span>
            <div className="fx-cap-pick">
              {camTitles().map((t, i) => <button key={i} type="button" className="fx-cap-opt" data-on={f.caps.includes(i)} onClick={() => toggleCap(i)}>{f.caps.includes(i) ? '✓ ' : ''}{t}</button>)}
            </div>
          </div>
          <label className="fx-ef full"><span className="fx-ef-k">Headline · one line the board reads</span><input value={f.headline} onChange={(e) => setF((p) => ({ ...p, headline: e.target.value }))} /></label>
          <label className="fx-ef full"><span className="fx-ef-k">Body · the answer prose</span><textarea value={f.body} rows={3} onChange={(e) => setF((p) => ({ ...p, body: e.target.value }))} /></label>
        </div>
        <div className="fx-edit-actions"><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>Save concern</button></div>
      </div>
    </div>
  );
}

// Layer A — edit every fact on a proposal. The AI match is a draft; after a call
// the CAM corrects contact, homes, dues, timeline, budget, price, narrative, etc.
// Saves write straight back into the lead (subs) + persist, so every view updates.
function EditDetailsModal({ sub, onClose, onSave }) {
  const [f, setF] = useState({
    community: sub.community || '', contact: sub.contact || '', contactRole: sub.contactRole || '',
    email: sub.email || '', phone: sub.phone || '', city: sub.city || '',
    homes: sub.homes || 0, metaType: sub.metaType || '', metaStatus: sub.metaStatus || '',
    dues: sub.dues || '', engageTimeline: sub.engageTimeline || '', budget: sub.budget || '',
    perHome: sub.perHome || 0, quote: sub.quote || '',
    // '' = follow the recommendation. Anything else is a deliberate human choice
    // and suppresses re-derivation from then on (proposals.tier_manual).
    tierOverride: sub.tierManual ? (sub.tierId || '') : '',
  });
  const upd = (k, v) => setF((p) => ({ ...p, [k]: v }));
  // What the recommendation will be when this is saved. Shown live, because the
  // tier decides the price on the BOARD's document and it is derived from these
  // answers — editing a budget used to change the offer with no visible feedback
  // until the toast after saving.
  const serviceTiers = cam().serviceTiers;
  // `services` is not editable here but IS the primary signal, so it has to be
  // carried into the preview or the readout would contradict what saving does.
  const rec = recommendTier({ homes: Number(f.homes) || 0, budget: f.budget, metaStatus: f.metaStatus, metaType: f.metaType, services: sub.services }, { serviceTiers });
  const effectiveTierId = f.tierOverride || rec.tierId;
  const tierChanges = effectiveTierId !== sub.tierId;
  // helper returns elements (not a component) so inputs keep focus across keystrokes
  const field = (k, label, opts = {}) => (
    <label className={'fx-ef' + (opts.full ? ' full' : '')} key={k}>
      <span className="fx-ef-k">{label}</span>
      {opts.area
        ? <textarea value={f[k]} rows={3} onChange={(e) => upd(k, e.target.value)} />
        : opts.options
          // A picker, not a text box: these answers are matched by KEYWORD to
          // recommend a tier, so "Financial" or "low budget" — both reasonable
          // things to type — silently matched nothing and left the tier alone.
          // Off-list values (older form wording, landing-page leads) are kept as
          // their own option rather than being blanked on save.
          ? (
            <>
              <select value={f[k]} onChange={(e) => upd(k, e.target.value)}>
                <option value="">— not answered —</option>
                {withCurrent(opts.options, f[k]).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              {isOffList(opts.options, f[k]) && <span className="fx-ef-note">Not one of the form's current options — kept as submitted.</span>}
            </>
          )
          : <input type={opts.num ? 'number' : 'text'} step={opts.num ? '0.01' : undefined} value={f[k]} onChange={(e) => upd(k, opts.num ? (parseFloat(e.target.value) || 0) : e.target.value)} />}
    </label>
  );
  return (
    <div className="ps-scrim" onClick={onClose}>
      <div className="ps-modal fx-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ps-modal-head"><span className="t">Edit details · {sub.community}</span><button className="x" onClick={onClose} aria-label="Close"><I.Close width={15} height={15} /></button></div>
        <div className="fx-edit-body">
          <div className="fx-edit-grid">
            {field('community', 'Community', { full: true })}
            {field('contact', 'Contact')}
            {field('contactRole', 'Role', { options: ROLE_OPTIONS })}
            {field('email', 'Email')}
            {field('phone', 'Phone')}
            {field('city', 'City / market')}
            {field('homes', 'Homes', { num: true })}
            {field('metaType', 'Type', { options: COMMUNITY_TYPE_OPTIONS })}
            {field('metaStatus', 'Current management status', { options: MANAGEMENT_STATUS_OPTIONS })}
            {field('dues', 'Monthly dues')}
            {field('engageTimeline', 'Timeline', { options: TIMELINE_OPTIONS })}
            {field('budget', 'Budget', { options: BUDGET_OPTIONS })}
            {field('perHome', 'Price / home ($/mo)', { num: true })}
            {/* The one place a human can name the tier. Needed because a CAM's
                downsell tier is deliberately never recommended (CMGT: Financial &
                Administrative), so there would otherwise be no way to reach it. */}
            <label className="fx-ef" key="tierOverride">
              <span className="fx-ef-k">Service tier</span>
              <select value={f.tierOverride} onChange={(e) => upd('tierOverride', e.target.value)}>
                <option value="">Follow the recommendation ({rec.tierName})</option>
                {TIERS.map((t) => <option key={t.id} value={t.id}>Set manually · {t.name}</option>)}
              </select>
              {!!f.tierOverride && <span className="fx-ef-note">Set by hand — the recommendation will no longer change it.</span>}
            </label>
            {field('quote', 'In their words (narrative)', { full: true, area: true })}
          </div>
        </div>
        <div className="fx-edit-rec" data-changed={tierChanges ? 'yes' : 'no'}>
          <span className="k">{f.tierOverride ? 'Tier (set by hand)' : 'Recommended tier'}{tierChanges ? ' · changes on save' : ''}</span>
          <span className="v">{tierById(effectiveTierId).name}</span>
          <span className="why">
            {f.tierOverride
              ? `The form points at ${rec.tierName}. ${rec.why}`
              : rec.why}
            {/* A tier this CAM won't lead with, that the board's answers point at.
                Staff-facing only — the board never sees the downsell. */}
            {rec.downsellFrom && !f.tierOverride
              ? ` They only asked for what ${rec.downsellName} covers — available as a downsell if the call goes that way.`
              : ''}
          </span>
        </div>
        <div className="fx-edit-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { onSave(f); onClose(); }}>Save details</button>
        </div>
      </div>
    </div>
  );
}

// Layer C — realign a proposal from a call transcript. Paste → LLM proposes a
// reviewable diff (changed facts + new concerns) → accept/reject → apply through
// the same write paths as hand-edits. Never auto-applies.
function RealignModal({ sub, onClose, onApply }) {
  const [transcript, setTranscript] = useState('');
  const [phase, setPhase] = useState('input'); // input | loading | review | error
  const [diff, setDiff] = useState(null);
  const [err, setErr] = useState('');
  const [accF, setAccF] = useState({});
  const [accC, setAccC] = useState({});
  const run = async () => {
    setPhase('loading'); setErr('');
    try {
      const proposal = { community: sub.community, contact: sub.contact, contactRole: sub.contactRole, email: sub.email, phone: sub.phone, city: sub.city, homes: sub.homes, metaType: sub.metaType, metaStatus: sub.metaStatus, dues: sub.dues, engageTimeline: sub.engageTimeline, budget: sub.budget, concerns: sub.concerns };
      const res = await realignFromTranscript(proposal, { uvps: cam().uvps.map((u) => ({ title: u.title, blurb: u.short })), transcript });
      const af = {}; (res.fieldChanges || []).forEach((_, i) => { af[i] = true; });
      const ac = {}; (res.addedConcerns || []).forEach((_, i) => { ac[i] = true; });
      setDiff(res); setAccF(af); setAccC(ac); setPhase('review');
    } catch (e) { setErr(String(e?.message || e)); setPhase('error'); }
  };
  const nAcc = diff ? (diff.fieldChanges || []).filter((_, i) => accF[i]).length + (diff.addedConcerns || []).filter((_, i) => accC[i]).length : 0;
  const apply = () => {
    const patch = {}; (diff.fieldChanges || []).forEach((f, i) => { if (accF[i]) patch[f.field] = f.to; });
    const concerns = (diff.addedConcerns || []).filter((_, i) => accC[i]);
    onApply(patch, concerns); onClose();
  };
  return (
    <div className="ps-scrim" onClick={onClose}>
      <div className="ps-modal fx-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ps-modal-head"><span className="t">Update from call · {sub.community}</span><button className="x" onClick={onClose} aria-label="Close"><I.Close width={15} height={15} /></button></div>
        {phase === 'input' && (<>
          <div className="fx-edit-body">
            <label className="fx-ef full"><span className="fx-ef-k">Paste the call transcript</span><textarea value={transcript} rows={10} autoFocus placeholder="Paste the notes or transcript from your call with the board…" onChange={(e) => setTranscript(e.target.value)} /></label>
            <div className="fx-realign-hint">The AI reads the call against this proposal and proposes updates — changed facts and any new concerns the board raised. You review each before anything is applied.</div>
          </div>
          <div className="fx-edit-actions"><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!transcript.trim()} onClick={run}>Realign from call</button></div>
        </>)}
        {phase === 'loading' && (<div className="fx-realign-load"><LottieScan size={88} className="fx-realign-scan" /><div className="fx-realign-load-t">Reading the call…</div><div className="fx-realign-load-s">Comparing the transcript against {sub.community}'s proposal</div></div>)}
        {phase === 'error' && (<>
          <div className="fx-edit-body"><div className="fx-realign-hint" style={{ color: '#a82451' }}>Couldn't realign: {err}</div></div>
          <div className="fx-edit-actions"><button className="btn btn-secondary" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={() => setPhase('input')}>Try again</button></div>
        </>)}
        {phase === 'review' && diff && (<>
          <div className="fx-edit-body">
            {diff.summary && <div className="fx-realign-summary"><I.Sparkle width={13} height={13} /> {diff.summary}</div>}
            {(diff.fieldChanges || []).length > 0 && <div className="fx-realign-sec">Detail changes</div>}
            {(diff.fieldChanges || []).map((f, i) => (
              <label key={'f' + i} className="fx-realign-row" data-on={!!accF[i]}>
                <input type="checkbox" checked={!!accF[i]} onChange={(e) => setAccF((p) => ({ ...p, [i]: e.target.checked }))} />
                <div><div className="fx-realign-row-k">{f.label}</div><div className="fx-realign-row-v"><span className="old">{f.from || '—'}</span> → <b>{f.to}</b></div></div>
              </label>
            ))}
            {(diff.addedConcerns || []).length > 0 && <div className="fx-realign-sec">New concerns from the call</div>}
            {(diff.addedConcerns || []).map((c, i) => (
              <label key={'c' + i} className="fx-realign-row" data-on={!!accC[i]}>
                <input type="checkbox" checked={!!accC[i]} onChange={(e) => setAccC((p) => ({ ...p, [i]: e.target.checked }))} />
                <div><div className="fx-realign-row-k">{c.label} <span className="fx-realign-fit">{c.fit}% fit</span></div><div className="fx-realign-row-v">{c.body}</div></div>
              </label>
            ))}
            {(diff.fieldChanges || []).length === 0 && (diff.addedConcerns || []).length === 0 && <div className="fx-realign-hint">No changes proposed — the call didn't surface anything new for this proposal.</div>}
          </div>
          <div className="fx-edit-actions"><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={nAcc === 0} onClick={apply}>Apply {nAcc} change{nAcc === 1 ? '' : 's'}</button></div>
        </>)}
      </div>
    </div>
  );
}

export default function ProposalsScreen() {
  // Real proposals from Supabase — and ONLY those. There is no demo pipeline to
  // fall back on, so this is legitimately empty on a fresh account until intake
  // drains the first lead in. Everything below must survive `[]`: `sub` is null
  // when nothing is selected, and each stage renders its own empty state.
  const initialLeads = getLeads();
  // View state mirrors the URL (?stage=&lead=) so a refresh stays put — reload
  // on Sent and you land back on Sent, not bounced to New.
  const [searchParams, setSearchParams] = useSearchParams();
  const STAGES = ['new', 'build', 'sent', 'won', 'library', 'archive'];
  const urlStage = STAGES.includes(searchParams.get('stage')) ? searchParams.get('stage') : 'new';
  const urlLead = searchParams.get('lead');
  const urlLeadOk = !!urlLead && initialLeads.some((l) => l.id === urlLead);
  const [subs, setSubs] = useState(initialLeads);
  const [selectedId, setSelectedId] = useState(urlLeadOk ? urlLead : (initialLeads[0]?.id || null));
  const [mode, setMode] = useState(urlStage);
  const [inbox, setInbox] = useState(!(urlStage === 'new' && urlLeadOk)); // New: lead in URL → drill-in
  const [focusBuild, setFocusBuild] = useState(urlStage !== 'build' || urlLeadOk); // Build: lead in URL → editor
  const [editOpen, setEditOpen] = useState(false); // Edit-details modal (Layer A)
  const [realignOpen, setRealignOpen] = useState(false); // "Update from call" transcript realign (Layer C)
  const [watchId, setWatchId] = useState(urlStage === 'sent' && urlLeadOk ? urlLead : null);
  const [sendOpen, setSendOpen] = useState(false); // Send is a modal off Build, not a stage
  const [syncing, setSyncing] = useState(false); // inbox "Sync now" pull in flight
  // When intake last pulled from WhatConverts. Seeded from the DB (max
  // leads.last_synced_at, stamped by sync-whatconverts) so it survives reload,
  // then bumped locally after a manual sync.
  const [syncedAt, setSyncedAt] = useState(() => DATA.intakeSyncedAt || null);
  // Archive bin — removed from the pipeline but kept as drain tombstones.
  const [archived, setArchived] = useState(() => DATA.archivedProposals || []);
  const [archiveTarget, setArchiveTarget] = useState(null); // lead pending the confirm modal
  const [moveTarget, setMoveTarget] = useState(null); // lead pending the stage-move modal
  const [deleteTargets, setDeleteTargets] = useState(null); // archived rows pending permanent deletion
  const [previewNonce, setPreviewNonce] = useState(0); // bump → Build preview iframe re-fetches
  const [matching, setMatching] = useState(null); // {community} while the LLM matches a new intake
  // Internal notes seed from the DB proposal's notes (live) — so they survive reload.
  const [notesMap, setNotesMap] = useState(() => { const m = {}; initialLeads.forEach((s) => { if (s.notes && s.notes.length) m[s.id] = s.notes; }); return m; });
  const [toast, setToast] = useState(null);
  const [launching, setLaunching] = useState(false);
  const [editorMap, setEditorMap] = useState(() => { const m = {}; initialLeads.forEach((s) => { m[s.id] = (s.sections || []).map((x) => ({ ...x })); }); return m; });
  const sub = subs.find((s) => s.id === selectedId) || subs[0] || null; // null = nothing in the pipeline
  const sections = editorMap[selectedId] || [];
  const perHome = sub ? sub.perHome : null; // single source — price edits write back into subs so every view (tier card, bucket, board) reflects them

  // Sticky toasts (a FAILED stage write) stay until dismissed — a 3.2s flash is
  // not good enough for "the database did not accept that".
  useEffect(() => { if (!toast || toast.sticky) return; const t = setTimeout(() => setToast(null), 3200); return () => clearTimeout(t); }, [toast]);

  // Relative labels ("synced 4m ago", lead ages) are computed at render, so the
  // screen needs a heartbeat or they freeze at whatever they said on mount.
  const [, setNowTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setNowTick((n) => n + 1), 60000); return () => clearInterval(id); }, []);

  // Always-current view of `subs` for the auto-drain interval, whose closure is
  // created once and would otherwise dedupe against a mount-time snapshot.
  const subsRef = useRef(subs);
  useEffect(() => { subsRef.current = subs; }, [subs]);
  // Archived lead keys must ALSO suppress minting, or the drain would see an
  // archived lead as "no proposal in the pipeline" and re-create it every tick.
  const archivedRef = useRef(archived);
  useEffect(() => { archivedRef.current = archived; }, [archived]);
  const syncFresh = syncFreshness(syncedAt ? Date.parse(syncedAt) : null);

  // Persist a proposal mutation to Supabase (live only; mock dev stays
  // session-local). RLS-scoped to the viewed account; keyed by lead_key.
  const live = isSupabaseConfigured && !!DATA.account?.id;
  const persist = (leadKey, patch) => {
    if (!live) return;
    supabase.from('proposals').update(patch)
      .eq('account_id', DATA.account.id).eq('lead_key', leadKey)
      .then(({ error }) => { if (error) setToast({ msg: 'Save failed: ' + error.message }); });
  };

  const meName = (DATA.user?.name || '').split(/\s+/)[0] || 'a teammate';
  // Opening a New lead's drill-in flips it New → Reviewed (records who/when).
  const markSeen = (id) => {
    const t = subs.find((s) => s.id === id);
    if (!t || t.status !== 'new' || t.openedAt) return;
    const now = new Date().toISOString();
    setSubs((prev) => prev.map((s) => (s.id === id ? { ...s, openedAt: now, openedBy: meName } : s)));
    persist(id, { opened_at: now, opened_by: meName });
  };
  // Keep the URL in sync with the view so refresh/deep-link restores it.
  useEffect(() => {
    const lead = (mode === 'new' && !inbox) ? selectedId
      : (mode === 'build' && focusBuild) ? selectedId
      : (mode === 'sent' && watchId) ? watchId
      : null;
    const next = { stage: mode };
    if (lead) next.lead = lead;
    setSearchParams(next, { replace: true });
  }, [mode, inbox, focusBuild, selectedId, watchId]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (id) => { if (id === 'sent') setWatchId(null); if (id === 'new') setInbox(true); if (id === 'build') setFocusBuild(false); setMode(id); }; // Build step with nothing focused → bucket list
  const openLead = (id) => { markSeen(id); setSelectedId(id); setInbox(false); setMode('new'); }; // grid card → drill into the analysis
  const selectRail = (id) => setSelectedId(id); // flip between leads inside the drill-in
  const pickSent = (id) => { setWatchId(id); setSelectedId(id); }; // focus a sent lead → also make it the selected proposal (so Edit/Realign target it)
  const backToInbox = () => setInbox(true);
  const resumeBuild = (id) => { setSelectedId(id); setFocusBuild(true); }; // pick a lead from the Build bucket list → its editor
  // ── Stage moves — the ONE write path ─────────────────────────────────────
  // Every transition (qualify, disqualify, won, lost, and now any demote) goes
  // through this. src/lib/proposalStage.js decides which fields the move writes,
  // so nothing here hand-maintains a camelCase and a snake_case copy of a patch.
  const movingRef = useRef(new Set()); // per-row in-flight lock

  // Unlike persist(), this VERIFIES the write. A Supabase update matching zero
  // rows returns no error, so a wrong lead_key would "succeed" and leave the
  // browser showing a stage the database never accepted. On failure the previous
  // stage tuple is put back and the toast is sticky.
  const writeStage = async (id, cols, rollbackView) => {
    if (!live) return true;
    const { data, error } = await supabase.from('proposals').update(cols)
      .eq('account_id', DATA.account.id).eq('lead_key', id).select('lead_key');
    if (error || !data || !data.length) {
      if (rollbackView) setSubs((p) => p.map((s) => (s.id === id ? { ...s, ...rollbackView } : s)));
      setToast({ msg: 'Stage change failed: ' + (error ? error.message : 'no matching proposal'), sticky: true });
      return false;
    }
    return true;
  };

  // Apply a prepared patch (used by the mover and by Undo, so both take the
  // identical path). `view` spreads into the row — never re-enrich, or the
  // board-engagement `watch` derived in loadData would be nulled on screen.
  const applyStagePatch = async (id, view, cols) => {
    if (movingRef.current.has(id)) return false;
    movingRef.current.add(id);
    const before = (() => { const r = subsRef.current.find((x) => x.id === id); return r ? stageSnapshot(r) : null; })();
    setSubs((p) => p.map((s) => (s.id === id ? { ...s, ...view } : s)));
    try {
      return await writeStage(id, cols, before ? before.view : null);
    } finally {
      movingRef.current.delete(id);
    }
  };

  const moveStage = async (id, target, opts = {}) => {
    const row = subsRef.current.find((s) => s.id === id);
    if (!row) return;
    const before = stageSnapshot(row); // BY VALUE, so Undo can't read stale state
    const patch = stageMovePatch(row, target, opts);
    if (patch.error) { setToast({ msg: patch.error }); return; }

    const ok = await applyStagePatch(id, patch.view, patch.cols);
    if (!ok) return;

    // Land the view where the row now lives, so no move leaves a focused stage
    // rendering a proposal that no longer belongs to it.
    const nav = patch.nav;
    setMode(nav.mode); setInbox(nav.inbox); setFocusBuild(nav.focusBuild);
    setWatchId(nav.watch ? id : null);
    if (nav.select) setSelectedId(id);

    setToast({
      msg: `${row.community} → ${STAGE_LABEL[target]}`,
      undo: () => applyStagePatch(id, before.view, before.cols),
    });
  };

  // The old one-way transitions, now thin wrappers over the mover.
  const qualify = (id, owner, quoteValue) => moveStage(id, 'build', { owner, quoteValue });
  const disqualify = (id, reason) => moveStage(id, 'disq', { disqReason: reason });
  // Archive = remove from the pipeline entirely (spam / duplicate / test), as
  // opposed to disqualify, which keeps a real-but-not-a-fit prospect in Won/Lost
  // as a record. The row is KEPT as a tombstone on purpose: the intake drain
  // decides what's new by "has no proposal yet", so a hard delete would be
  // re-minted (and re-LLM-matched) on the next tick. See the migration comment.
  const archiveLead = (id, reason) => {
    const sub = subs.find((s) => s.id === id);
    if (!sub) return;
    const at = new Date().toISOString();
    const by = DATA.user?.name || '';
    setSubs((p) => p.filter((s) => s.id !== id));
    setArchived((p) => [{ ...sub, archivedAt: at, archivedReason: reason || '', archivedBy: by }, ...p]);
    // Leaving the focused lead: fall back to the inbox so we don't render a
    // detail view for a lead that's no longer in `subs`.
    if (selectedId === id) { setInbox(true); setWatchId(null); }
    persist(id, { archived_at: at, archived_reason: reason || '', archived_by: by });
    setToast({ msg: `${sub.community} removed — in Archive`, undo: () => restoreLead(id) });
  };
  // Permanently delete archived leads. ORDER MATTERS: flag the lead junk FIRST.
  // The drain mints anything in `leads` with no proposal row, so deleting the row
  // before the flag lands would race the 3-minute tick and re-create it. If the
  // flag fails we abort WITHOUT deleting — leaving it archived is recoverable,
  // deleting it and having it silently return is not.
  const deleteArchived = async (rows, leadStatus) => {
    if (!live) { setToast({ msg: 'Mock dev — nothing was deleted.' }); return; }
    // Deleting is as account-scoped as minting. Staff can open any client's
    // cockpit, and this both destroys rows AND writes spam/duplicate to that
    // client's real WhatConverts leads — neither belongs on a non-proposals
    // account, whose archive should be empty anyway.
    if (!canMintProposals(DATA.account)) {
      throw new Error(`${DATA.account?.shortName || 'This account'} does not run the proposal system.`);
    }
    // Which of these still have a lead behind them. A row the SYNC archived
    // ("Deleted in WhatConverts") has none — the same prune that archived it
    // deleted the lead — and qualify-lead 404s on a missing lead, which would
    // make exactly those rows permanently undeletable. No lead means nothing to
    // flag and nothing to re-mint from, so the delete alone is sufficient.
    const withLead = new Set();
    {
      const { data } = await supabase.from('leads')
        .select('wc_lead_id').eq('account_id', DATA.account.id)
        .in('wc_lead_id', rows.map((r) => r.id));
      for (const l of data || []) withLead.add(String(l.wc_lead_id));
    }
    const done = [];
    for (const r of rows) {
      try {
        if (withLead.has(String(r.id))) await qualifyLead(r.id, { quotable: 'no', leadStatus });
      } catch (e) {
        if (done.length) { setArchived((p) => p.filter((x) => !done.includes(x.id))); }
        throw new Error(`could not mark "${r.community || r.id}" as ${leadStatus} in WhatConverts (${(e && e.message) || e}). ${done.length} deleted before this.`);
      }
      const { error } = await supabase.from('proposals').delete()
        .eq('account_id', DATA.account.id).eq('lead_key', r.id);
      if (error) {
        if (done.length) { setArchived((p) => p.filter((x) => !done.includes(x.id))); }
        throw new Error(`delete failed for "${r.community || r.id}": ${error.message}. ${done.length} deleted before this.`);
      }
      done.push(r.id);
    }
    setArchived((p) => p.filter((x) => !done.includes(x.id)));
    setToast({ msg: done.length === 1 ? `${rows[0].community || 'Lead'} deleted for good` : `${done.length} leads deleted for good` });
  };
  const restoreLead = (id) => {
    // archivedRef, not `archived`: archiveLead's toast closes over the render it
    // was created in, whose `archived` array does NOT yet contain this row — so
    // the old lookup always missed and Undo silently did nothing.
    const a = archivedRef.current.find((s) => s.id === id);
    if (!a) return;
    setArchived((p) => p.filter((s) => s.id !== id));
    // Re-enrich: the bin holds a light shape (no match/sections), and every
    // pipeline view expects the enriched view-model.
    setSubs((p) => [enrichLead({ ...a, archivedAt: null, archivedReason: '', archivedBy: '' }, cam()), ...p]);
    persist(id, { archived_at: null, archived_reason: '', archived_by: '' });
    setToast({ msg: `${a.community} restored to the pipeline` });
  };
  const addNote = (id, text) => {
    const next = [{ who: DATA.user?.name || meName || 'You', when: 'Just now', text }, ...(notesMap[id] || [])];
    setNotesMap((m) => ({ ...m, [id]: next }));
    persist(id, { notes: next });
  };
  const toggle = (id) => setEditorMap({ ...editorMap, [selectedId]: sections.map((s) => (s.id === id && !s.required ? { ...s, on: !s.on } : s)) });
  const setProse = (id, text) => setEditorMap({ ...editorMap, [selectedId]: sections.map((s) => (s.id === id ? { ...s, prose: text } : s)) });
  // Editing the rate must re-derive the stored ANNUAL too. quote_value used to be
  // left untouched here, so the moment anyone adjusted the price the stored annual
  // disagreed with every figure on screen — and it is what the Qualify / Won
  // modals prefill from and what roll-ups read.
  const setPerHome = (v) => {
    setSubs((p) => p.map((s) => s.id === selectedId ? { ...s, perHome: v } : s));
    if (!Number.isFinite(Number(v))) return;
    const row = subsRef.current.find((s) => s.id === selectedId);
    persist(selectedId, {
      per_home: Number(v),
      quote_value: Math.round(pricing({ ...row, perHome: Number(v) }).monthlyNum * 12),
    });
  };
  // Layer A — apply edited facts to the focused lead + persist to its columns.
  const saveDetails = (f) => {
    const homes = parseInt(f.homes) || 0, perHome = Number(f.perHome) || 0;
    const current = subsRef.current.find((s) => s.id === selectedId) || {};
    // RE-DERIVE THE TIER. tier_id was written exactly once — at mint, from whatever
    // form fields had arrived by then — and nothing ever recomputed it. So editing
    // the door count or the budget answer here left the tier, and therefore the
    // price, derived from facts that no longer held. Observed live: an 834-home
    // board that wrote "Tight budget — financial only" sat stored as Full-Service
    // at the per-home default, quoting $7,489/mo where the form points at on-site.
    //
    // Nothing is clobbered by doing this: there is no tier picker anywhere in the
    // UI, so a stored tier can only ever be a derived value, never a human choice.
    // The RATE is different — Build lets staff set it — so it is only re-based when
    // it is still the outgoing tier's default, i.e. demonstrably never touched.
    // The modal's tier picker: '' = follow the recommendation, anything else is a
    // human decision that must survive every later edit.
    const manual = !!f.tierOverride;
    const facts = { ...f, homes, perHome, services: current.services,
      tierManual: manual, tierId: manual ? f.tierOverride : current.tierId };
    const d = deriveTierAndPrice(current, facts, { serviceTiers: cam().serviceTiers });
    const rec = d.rec;
    const tierChanged = d.tierId !== current.tierId;
    const nextPerHome = d.perHome;
    const patched = { ...current, ...f, homes, perHome: nextPerHome, tierId: d.tierId, tierManual: manual };
    // enrichLead prefers a row's existing quoteValue over deriving one, so the new
    // annual is computed here and passed in — otherwise the edit would persist a
    // fresh number to the database while the screen kept showing the old one.
    const quoteValue = d.quoteValue;
    // Re-enrich rather than patch: tierName, tierRec and intakeFlags are all
    // derived from these facts, and patching left them describing the old ones.
    setSubs((p) => p.map((s) => s.id === selectedId ? enrichLead({ ...patched, quoteValue }, cam()) : s));
    persist(selectedId, {
      community: f.community, contact: f.contact, contact_role: f.contactRole, email: f.email, phone: f.phone,
      city: f.city, homes, meta_type: f.metaType, meta_status: f.metaStatus, dues: f.dues,
      engage_timeline: f.engageTimeline, budget: f.budget, per_home: nextPerHome, quote: f.quote,
      // d.tierId, NOT rec.tierId: when a staffer sets the tier by hand the
      // recommendation is deliberately not what gets stored.
      tier_id: d.tierId,
      tier_manual: manual,
      // homes AND per_home both feed the floor, so the annual is re-derived here
      // as well — editing the door count silently invalidated it otherwise.
      quote_value: quoteValue,
    });
    setToast({ msg: tierChanged ? `Details updated — tier is now ${tierById(d.tierId).name}` : 'Details updated' });
  };
  // Layer B — apply hand-edited concerns to the focused lead's match + persist the
  // override to match_snapshot, so the cockpit, board doc, and reloads all use it.
  const applyMatch = (concerns, overall) => {
    const m = recomputeMatch(concerns, overall, sub._source);
    setSubs((p) => p.map((s) => s.id === selectedId ? { ...s, ...m } : s));
    persist(selectedId, { match_snapshot: m });
    setPreviewNonce((n) => n + 1); setTimeout(() => setPreviewNonce((n) => n + 1), 700); // refresh Build preview once the write lands
    setToast({ msg: 'Match updated' });
  };
  // Layer C — apply accepted realign changes: patch the facts + append new concerns,
  // through the same write paths as hand-edits (Layer A + B).
  const applyRealign = (fieldPatch, addedConcerns) => {
    const COL = { community: 'community', contact: 'contact', contactRole: 'contact_role', email: 'email', phone: 'phone', city: 'city', homes: 'homes', metaType: 'meta_type', metaStatus: 'meta_status', dues: 'dues', engageTimeline: 'engage_timeline', budget: 'budget' };
    const patch = { ...fieldPatch };
    if (patch.homes != null) patch.homes = parseInt(patch.homes) || sub.homes;
    if (Object.keys(patch).length) {
      // RE-DERIVE, exactly as "Edit details" does. The call is the main way a
      // board's real scope gets established — "we only want the financials", "we
      // need someone on site" — and this path used to patch the fact and leave
      // tier_id and per_home on whatever intake guessed, so the proposal sent at
      // the wrong tier and the wrong price. Same function as saveDetails, so the
      // two cannot drift again; a hand-set tier still wins (tierManual).
      const current = subsRef.current.find((x) => x.id === selectedId) || sub;
      const d = deriveTierAndPrice(current, patch, { serviceTiers: cam().serviceTiers });
      const patched = { ...current, ...patch, perHome: d.perHome, tierId: d.tierId };
      setSubs((p) => p.map((s) => s.id === selectedId
        ? enrichLead({ ...patched, quoteValue: d.quoteValue }, cam())
        : s));
      const cols = {}; Object.entries(patch).forEach(([k, v]) => { if (COL[k]) cols[COL[k]] = v; });
      persist(selectedId, { ...cols, tier_id: d.tierId, per_home: d.perHome, quote_value: d.quoteValue });
      if (d.tierChanged) setToast({ msg: `Realigned — tier is now ${tierById(d.tierId).name}` });
    }
    if (addedConcerns && addedConcerns.length) applyMatch([...sub.concerns, ...addedConcerns], sub.match);
    setToast({ msg: 'Proposal realigned from the call' });
  };
  // Real send: the proposal-send edge fn emails the board the magic link + marks
  // the proposal sent in the DB. Only advance to the Sent screen if it succeeds.
  // Mock dev (no Supabase) keeps the local-only behavior so the demo still flows.
  const send = async (recipient) => {
    if (live) {
      const { data, error } = await supabase.functions.invoke('proposal-send', {
        body: { leadKey: selectedId, accountId: DATA.account.id, to: recipient || undefined, baseUrl: window.location.origin },
      });
      let detail = data?.error || '';
      if (error && !detail) { try { detail = (await error.context.json())?.error || error.message; } catch { detail = error.message; } }
      if (detail) { setToast({ msg: 'Send failed: ' + detail }); return; }
      setToast({ msg: `Proposal emailed to ${data.to}` });
    }
    // Remember the address we actually sent to (may be a custom email, not the
    // intake one) so resend/nudge and the "Sent to" line all use it.
    setSubs((p) => p.map((s) => (s.id === selectedId && s.status !== 'accepted' ? { ...s, status: 'sent', email: recipient || s.email } : s)));
    setWatchId(selectedId); // land in Sent focused on this proposal's engagement
    setMode('sent');
  };
  const launch = (recipient) => { setLaunching(true); setTimeout(() => { setLaunching(false); send(recipient); }, 1850); };
  // Resend / nudge — re-email the magic link to the address the proposal was
  // sent to (persisted on the row, so a custom recipient is honored, not the
  // original intake email). proposal-send with no `to` uses proposals.email.
  // `message` (nudge only) becomes the email body server-side; `cc` copies other
  // board members. Plain resend passes neither and re-sends the full proposal.
  const resendProposal = async (s, label, { message, cc } = {}) => {
    const ccList = (cc || []).filter(Boolean);
    if (live) {
      const { data, error } = await supabase.functions.invoke('proposal-send', {
        body: {
          leadKey: s.id, accountId: DATA.account.id, baseUrl: window.location.origin,
          ...(message ? { message } : {}),
          ...(ccList.length ? { cc: ccList } : {}),
        },
      });
      let detail = data?.error || '';
      if (error && !detail) { try { detail = (await error.context.json())?.error || error.message; } catch { detail = error.message; } }
      if (detail) { setToast({ msg: `${label} failed: ` + detail }); return; }
      const nCc = (data.cc || []).length;
      setToast({ msg: `${label} to ${data.to}${nCc ? ` (cc ${nCc})` : ''}` });
    } else {
      setToast({ msg: `${label} to ${s.email || s.firstName}${ccList.length ? ` (cc ${ccList.length})` : ''}` });
    }
  };
  // Mint a proposal from a WhatConverts intake lead (idempotent on lead_key) and
  // run the LLM match once. No popup, no per-lead navigation — used by the
  // auto-sync below. Returns the enriched proposal, or null if it already exists.
  const mintLead = async (lead) => {
    // subsRef, not subs: the auto-drain interval is set up once, so a closure
    // over `subs` would freeze at mount and re-mint (and re-LLM-match) the same
    // leads on every tick.
    if (subsRef.current.some((s) => s.id === lead.id)) return null; // already in the pipeline
    if (archivedRef.current.some((s) => s.id === lead.id)) return null; // archived — stay gone
    const raw = leadToProposalRaw(lead, { serviceTiers: cam().serviceTiers });
    if (live) {
      // .select() the generated board_token BACK. The magic-link secret is created
      // by a column default, so if we don't read it here the freshly minted row
      // carries no boardToken, BOARD_URL falls back to the lead_key, and
      // proposal-board — which resolves board_token ONLY, deliberately, because
      // WhatConverts lead ids are sequential and guessable — finds nothing. The
      // Build live preview then rendered "This proposal link is invalid or has
      // expired" for every lead qualified in-session, healing itself on the next
      // page load (loadData supplies board_token), which is what made it look
      // intermittent. Sending was never affected; only the in-session preview.
      const { data: minted, error } = await supabase.from('proposals').upsert({
        account_id: DATA.account.id, lead_key: raw.id, sort: 100,
        community: raw.community, contact: raw.contact, contact_role: raw.contactRole, first_name: raw.firstName,
        city: raw.city, homes: raw.homes, email: raw.email, phone: raw.phone,
        meta_type: raw.metaType, meta_status: raw.metaStatus, dues: raw.dues,
        engage_timeline: raw.engageTimeline, budget: raw.budget, quote: raw.quote, received: raw.received,
        // The lead's REAL submission time. Without this the inbox would date the
        // lead from this insert, which on a backlog sync is weeks off.
        received_at: raw.receivedAt,
        status: 'new', selected_pains: raw.selectedPains, tier_id: raw.tierId || 'full', per_home: raw.perHome,
        // The board's "Services you're looking for" answer — the primary input to
        // the tier recommendation, kept as submitted so a later mapping change
        // reads old leads correctly. Never persisted before, so the signal died
        // with the mint and any later edit re-derived without it.
        services: raw.services || null,
        // Same gap, one line below it in proposalIntake: the board tells us they
        // have a pool, a clubhouse, a gated entry — and the answer was dropped.
        // Doesn't feed the tier; it is context a CAM should be able to read.
        amenities: raw.amenities || null,
        // Minted tiers are always derived; only a human sets this.
        tier_manual: false,
        // Origin matters: sync-whatconverts only auto-archives source='whatconverts'
        // rows when their lead disappears upstream. Seeded rows must never match.
        source: 'whatconverts',
      }, { onConflict: 'account_id,lead_key' }).select('board_token').maybeSingle();
      if (error) { setToast({ msg: 'Sync insert failed: ' + error.message }); return null; }
      if (minted && minted.board_token) raw.boardToken = minted.board_token;
    }
    // LLM match (the smart one) when enabled — run ONCE, persist as match_snapshot
    // so it's stable + survives reload. Falls back to the tag engine on any error.
    let snapshot = null;
    if (LLM_ENABLED) {
      setMatching({ community: raw.community });
      try {
        snapshot = await matchLeadWithLLM(raw, { uvps: cam().uvps.map((u) => ({ title: u.title, blurb: u.short })), painPoints: PAIN_POINTS });
        if (live && snapshot) await supabase.from('proposals').update({ match_snapshot: snapshot }).eq('account_id', DATA.account.id).eq('lead_key', raw.id);
      } catch (e) { /* LLM unavailable → deterministic engine */ }
    }
    const enriched = enrichLead({ ...raw, matchSnapshot: snapshot || undefined }, cam());
    setSubs((p) => [enriched, ...p.filter((s) => s.id !== enriched.id)]);
    setEditorMap((m) => ({ ...m, [enriched.id]: (enriched.sections || []).map((x) => ({ ...x })) }));
    return enriched;
  };

  // Intake → inbox. HOA filter mirrors the old intake picker.
  //
  // TWO LAYERS, and only one of them used to be automatic:
  //   WhatConverts → `leads`   — automatic (whatconverts-daily cron every 30min
  //                              + whatconverts-webhook for near-instant).
  //   `leads` → `proposals`    — WAS manual-only, on this button. So leads piled
  //                              up in the DB and only became inbox cards when a
  //                              human happened to click, dumping months of
  //                              backlog in one burst (observed: 22 leads
  //                              spanning May 9 → Aug 11, all minted inside 2
  //                              minutes). The screen's own copy already
  //                              promises "lands here automatically".
  //
  // Now: `drain()` mints whatever is sitting in `leads`, and runs on mount + on
  // an interval while the cockpit is open. The button additionally FORCES a
  // WhatConverts pull first — the expensive part (multi-page, 400-day window),
  // which the cron already does on schedule, so the automatic path never calls it.
  // Cap per pass. Each mint is a DB write + (when enabled) one LLM match call, so
  // an unbounded auto-drain on a fresh account with a big archive would fire
  // hundreds of them unattended. Leftovers are REPORTED, never silently dropped.
  const DRAIN_CAP = 25;
  const AUTO_POLL_MS = 180000; // 3 min while the screen is open
  const draining = useRef(false);   // reentrancy guard across mount + interval
  const [pendingMore, setPendingMore] = useState(0); // backlog beyond the cap

  // Mint anything in `leads` that has no proposal yet. Returns how many landed.
  // `silent` = the automatic path: no toast unless it actually found something.
  const drain = async ({ silent = false } = {}) => {
    // ONLY the proposals account gets a pipeline. Staff can open any client's
    // cockpit, and this used to mint a proposal per eligible lead for whoever
    // was open — which manufactured 90 rows on Edison and 6 on Tidewater,
    // neither of which runs proposals. Access is staff-wide; WRITING is not.
    if (!canMintProposals(DATA.account)) return 0;
    if (draining.current) return 0;
    draining.current = true;
    try {
      let leads = DATA.recentLeads || [];
      if (live) {
        // Windowed: `fields` is JSONB and some accounts hold thousands of leads,
        // so an unbounded select on a 3-minute poll would be a big repeat
        // payload. 200 newest is far more than one pass can mint, and repeated
        // passes still converge on a large archive.
        const { data, error } = await supabase.from('leads')
          .select('wc_lead_id, name, email, phone, company, type, fields, created_at, lead_status, quotable')
          .eq('account_id', DATA.account.id).order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        // lead_status carries the spam/duplicate marking — without it selectIntakeBatch
        // can't filter junk and would mint it anyway.
        leads = (data || []).map((l) => ({ id: l.wc_lead_id, name: l.name, email: l.email, phone: l.phone, company: l.company, type: l.type, fields: l.fields, date: l.created_at, leadStatus: l.lead_status, quotable: l.quotable }));
      }
      // Newest first (the select is DESC) so a capped pass works the freshest
      // leads. subsRef, not subs — see mintLead.
      const { batch, remaining } = selectIntakeBatch({
        leads,
        // Pipeline AND archive: an archived lead has no pipeline row, so without
        // its id here every tick would resurrect the spam you just removed.
        existingIds: [...subsRef.current.map((x) => x.id), ...archivedRef.current.map((x) => x.id)],
        cap: DRAIN_CAP,
      });
      setPendingMore(remaining);
      let n = 0;
      for (const l of batch) { if (await mintLead(l)) n++; }
      if (n && !silent) { setMode('new'); setInbox(true); }
      return n;
    } finally {
      draining.current = false;
      // The matching overlay is a FULL-SCREEN blocking scrim raised per lead by
      // mintLead, and this is the only function that calls mintLead — so this is
      // the only correct place to lower it. It used to be cleared solely in
      // syncNow's finally, i.e. only when a human clicked "Sync intake". The
      // automatic drain (mount + 3-min tick) reaches mintLead without going
      // through syncNow, so a lead that arrived on its own raised the scrim and
      // nothing ever took it down: the cockpit locked until a page reload, with
      // "Matching <community>…" spinning forever. The lead itself was already
      // minted and matched — only the overlay was stuck.
      setMatching(null);
    }
  };

  // Manual "Sync intake now": force a WhatConverts pull, then drain.
  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      if (live) await supabase.functions.invoke('sync-whatconverts', { body: { accountId: DATA.account.id } });
      const n = await drain();
      setSyncedAt(new Date().toISOString());
      setMode('new'); setInbox(true); // surface the inbox so new leads are visible
      setToast({ msg: n ? `${n} new lead${n === 1 ? '' : 's'} pulled in from intake` : 'Up to date — no new intake leads' });
    } catch (e) {
      setToast({ msg: 'Sync failed: ' + (e?.message || e) });
    } finally {
      setMatching(null);
      setSyncing(false);
    }
  };

  // Automatic drain: once on mount, then every AUTO_POLL_MS while open. Reads
  // only the `leads` table (cheap) — the cron owns the WhatConverts pull. Keeps
  // the inbox current without anyone clicking, which is what removes the dump.
  useEffect(() => {
    if (!live) return;
    let alive = true;
    const tick = async (silent) => {
      if (!alive) return;
      try {
        const n = await drain({ silent });
        if (alive && n) setToast({ msg: `${n} new lead${n === 1 ? '' : 's'} arrived from intake` });
      } catch { /* transient — the next tick retries */ }
    };
    tick(true); // catch up on open, quietly
    const id = setInterval(() => tick(false), AUTO_POLL_MS);
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  return (
    <div className="proposal-system">
      <div className="v2-topline">
        <Stepper mode={mode} go={go} />
        <div className="fx-side">
          {/* The dot used to be decorative and the label read "Sync intake now",
              which looked like a live/up-to-date status when it was only a
              button. It now reports the REAL last pull (max leads.last_synced_at)
              and colors the dot by staleness against the 30-min cron. */}
          <button className="fx-sync" data-fresh={syncFresh} onClick={syncNow} disabled={syncing}
            title={syncedAt
              ? `Intake last pulled from WhatConverts ${fmtReceived(Date.parse(syncedAt))} (${ageAgo(Date.parse(syncedAt))}). Auto-checks every 3 min while this screen is open; the server pulls every 30 min. Click to force a pull now.`
              : 'Pull the latest intake submissions from WhatConverts into the inbox'}>
            <span className={'live' + (syncing ? ' busy' : '')} aria-hidden="true" />
            {syncing ? 'Syncing intake…' : (
              <span className="fx-sync-txt">
                <span className="l">Sync intake</span>
                <span className="s">{syncedAt ? `synced ${ageAgo(Date.parse(syncedAt))}` : 'never synced'}</span>
              </span>
            )}
          </button>
          <button className="v2-lib-btn" data-on={mode === 'library'} onClick={() => setMode('library')} title="The capabilities every proposal matches against">
            <I.Bolt width={14} height={14} /> UVP Library
          </button>
          {/* Not a pipeline stage, so it sits off the rail rather than in the
              stepper. Shown once something's in it, or while you're viewing it. */}
          {(archived.length > 0 || mode === 'archive') && (
            <button className="v2-lib-btn" data-on={mode === 'archive'} onClick={() => setMode('archive')} title="Leads removed from the pipeline">
              <I.Archive width={14} height={14} /> Archive <b>{archived.length}</b>
            </button>
          )}
        </div>
      </div>

      {/* Pinned lead card — the spine below the stepper while a lead is focused in Build. */}
      {mode === 'build' && focusBuild && sub && stageOf(sub) === 'qualified' && sub.status !== 'sent' && (
        <>
          <StageToolbar backLabel="All in Build" onBack={() => setFocusBuild(false)} actions={[
            { icon: icoOpen(), label: 'Open full proposal', onClick: () => window.open(BOARD_URL(sub), '_blank', 'noopener') },
            { icon: icoEdit(), label: 'Edit details', onClick: () => setEditOpen(true) },
            { icon: icoPhone(), label: 'Update from call', onClick: () => setRealignOpen(true) },
            { icon: icoMove(), label: 'Move stage', onClick: () => setMoveTarget(sub) },
            { label: 'Send proposal', onClick: () => setSendOpen(true), primary: true, arrow: true },
          ]} />
          <PinnedCard sub={sub} stage="build" perHome={perHome} setPerHome={setPerHome} />
        </>
      )}

      {/* New — inbox grid of un-worked leads, drill into one for the match analysis. */}
      {mode === 'new' && (
        <ReviewScreen subs={subs} selectedId={selectedId} sub={sub} inbox={inbox} onOpenLead={openLead} onBack={backToInbox} onSelectRail={selectRail} onQualify={qualify} onDisqualify={disqualify} onBuild={() => { setMode('build'); setFocusBuild(true); }} onEditDetails={() => setEditOpen(true)} onApplyMatch={applyMatch} perHome={perHome} setPerHome={setPerHome} onRealign={() => setRealignOpen(true)} onMove={setMoveTarget}
          pendingMore={pendingMore} onSyncMore={syncNow} syncing={syncing} onArchive={setArchiveTarget} />
      )}
      {/* Build — write it. A focused qualified lead opens the editor; otherwise the bucket list. */}
      {mode === 'build' && (
        (focusBuild && sub && stageOf(sub) === 'qualified' && sub.status !== 'sent')
          ? <BuildStage sub={sub} sections={sections} toggle={toggle} perHome={perHome} setPerHome={setPerHome} onApplyMatch={applyMatch} previewNonce={previewNonce} onContinue={() => setSendOpen(true)} live={live} />
          : <BuildBucket subs={subs} editorMap={editorMap} onResume={resumeBuild} />
      )}
      {/* Sent — their court: engagement tracking + board responses + follow-up. */}
      {mode === 'sent' && (
        <CloseView subs={subs} watchId={watchId} setWatchId={setWatchId} onPick={pickSent}
          onResend={(s) => resendProposal(s, 'Magic link resent')}
          onNudge={(s, opts) => resendProposal(s, 'Nudge sent', opts)}
          onMove={setMoveTarget} notesMap={notesMap} addNote={addNote}
          onEditDetails={() => setEditOpen(true)} onRealign={() => setRealignOpen(true)} onOpenFull={(s) => window.open(BOARD_URL(s), '_blank', 'noopener')} />
      )}
      {/* Won / Lost — closed outcomes. */}
      {mode === 'won' && <WonLostView subs={subs} onMove={setMoveTarget} />}
      {/* Client — retained book of business. */}
      {mode === 'library' && <UVPLibrary />}
      {mode === 'archive' && <ArchiveView archived={archived} onRestore={restoreLead} onDelete={setDeleteTargets} />}

      {/* Every one of these acts ON the focused lead, so they can't open without
          one — guarded so an empty pipeline can never deref a null `sub`. */}
      {sendOpen && sub && <SendModal sub={sub} onClose={() => setSendOpen(false)} onSend={(r) => launch(r)} />}
      {editOpen && sub && <EditDetailsModal sub={sub} onClose={() => setEditOpen(false)} onSave={saveDetails} />}
      {realignOpen && sub && <RealignModal sub={sub} onClose={() => setRealignOpen(false)} onApply={applyRealign} />}
      {archiveTarget && <ArchiveModal s={archiveTarget} onClose={() => setArchiveTarget(null)} onArchive={archiveLead} />}
      {deleteTargets && deleteTargets.length > 0 && (
        <DeleteArchivedModal rows={deleteTargets} onClose={() => setDeleteTargets(null)} onDelete={deleteArchived} />
      )}
      {moveTarget && <MoveStageModal s={moveTarget} live={live} onClose={() => setMoveTarget(null)} onMove={moveStage} onSendInstead={() => { setSelectedId(moveTarget.id); setSendOpen(true); }} />}
      {matching && (
        <div className="v2-launch">
          <div className="v2-launch-card fx-scan-card">
            <div className="fx-scan-glow"><LottieScan size={92} className="v2-launch-scan" /></div>
            <div className="fx-scan-eyebrow"><span className="fx-scan-dot" aria-hidden="true" />Matching engine · Working</div>
            <div className="v2-launch-txt">Matching {matching.community} with {cam().shortName}’s expertise</div>
            <div className="v2-launch-sub">Reading the board's intake and mapping each concern to your UVPs.</div>
            <div className="fx-scan-bar"><span /></div>
          </div>
        </div>
      )}
      {launching && sub && <LaunchOverlay sub={sub} />}
      {toast && (
        <div className="ps-toast">
          <span className="ic"><I.Check width={14} height={14} /></span>{toast.msg}
          {/* Removing a lead is one click, so it gets a one-click way back. */}
          {toast.undo && <button className="ps-toast-undo" onClick={() => { const u = toast.undo; setToast(null); u(); }}>Undo</button>}
          {toast.sticky && <button className="ps-toast-undo" onClick={() => setToast(null)}>Dismiss</button>}
        </div>
      )}
    </div>
  );
}

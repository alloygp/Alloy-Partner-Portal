// ============================================================================
// Runtime LLM matcher (client side).
//
// Calls the proposal-match edge function for a live, LLM-computed match, and
// returns the same shape as the deterministic engine (deriveLeadMatch). Callers
// should fall back to the deterministic engine on throw, so the cockpit always
// renders even if the LLM is unavailable.
//
// This is the only LLM path: every lead is real, so a match is either computed
// here at intake (and persisted as proposals.match_snapshot) or falls back to the
// deterministic engine. Nothing is pre-baked.
//
// Gated by VITE_PROPOSAL_LLM so it's inert until explicitly enabled.
// ============================================================================

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY;
// LLM matching + transcript realign are core to the live proposal system, and
// they only run against our edge functions — which require Supabase anyway. So
// enable whenever the app is wired to Supabase (local, staging, prod), instead
// of depending on a build-time flag that has to be mirrored into every deploy.
// Opt OUT with VITE_PROPOSAL_LLM=0 (forces the deterministic engine). Without
// Supabase there are no leads to match at all.
export const LLM_ENABLED = !!SUPABASE_URL && !!ANON_KEY && String(import.meta.env?.VITE_PROPOSAL_LLM || "") !== "0";

// Every call here happens while a BLOCKING overlay is on screen ("Matching
// engine · Working" / the realign modal's spinner), so a request that never
// settles is a locked cockpit, not a slow one. fetch has no default timeout, so
// without this an edge function that stalls — cold start, Anthropic hanging,
// a dropped connection — held the UI open indefinitely. On timeout we throw,
// which every caller already handles by falling back to the deterministic
// engine. Measured: a real proposal-match round trip is ~6s.
const TIMEOUT_MS = 60000;

async function postJSON(fn, body, timeoutMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: ANON_KEY,
        authorization: `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    // Distinguish "we gave up waiting" from a network error, so the console says
    // which one happened rather than a bare AbortError.
    if (e && e.name === "AbortError") throw new Error(`${fn} timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`${fn} ${resp.status}`);
  const data = await resp.json();
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function matchLeadWithLLM(lead, { uvps, painPoints }) {
  if (!LLM_ENABLED) throw new Error("LLM matching disabled (set VITE_PROPOSAL_LLM=1)");
  if (!SUPABASE_URL || !ANON_KEY) throw new Error("Supabase env not configured");

  // { match, concerns, scores, links, capsMatched, capsTotal, _source:'llm', model }
  return await postJSON("proposal-match", { lead, uvps, painPoints });
}

// Layer C — realign a proposal from a sales-call transcript. Returns a reviewable
// diff: { summary, fieldChanges:[{field,label,from,to}], addedConcerns:[concern], model }.
export async function realignFromTranscript(proposal, { uvps, transcript }) {
  if (!LLM_ENABLED) throw new Error("LLM matching disabled (set VITE_PROPOSAL_LLM=1)");
  if (!SUPABASE_URL || !ANON_KEY) throw new Error("Supabase env not configured");
  return await postJSON("proposal-realign", { proposal, uvps, transcript });
}

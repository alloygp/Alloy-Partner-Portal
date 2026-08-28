import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The LLM calls run behind a FULL-SCREEN blocking overlay (the "Matching engine ·
// Working" scrim, and the realign modal). A request that never settles therefore
// locks the cockpit, so the timeout below is load-bearing UI behaviour, not a
// nicety — that is what these tests pin.
//
// LLM_ENABLED and the Supabase URL/key are read at MODULE LOAD from
// import.meta.env, so every case stubs the env first and then imports fresh.
async function loadModule() {
  vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
  vi.resetModules();
  return await import("./proposalLLM.js");
}

const LEAD = { community: "Alloy Coves", selectedPains: ["communication"], quote: "no callbacks" };
const UVPS = [{ title: "Same-day response", blurb: "97% same day" }];

describe("matchLeadWithLLM", () => {
  beforeEach(() => { vi.unstubAllEnvs(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("posts to proposal-match with the anon key and returns the match", async () => {
    const { matchLeadWithLLM } = await loadModule();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: () => Promise.resolve({ match: 92, concerns: [], _source: "llm" }),
    });

    const out = await matchLeadWithLLM(LEAD, { uvps: UVPS, painPoints: [] });

    expect(out.match).toBe(92);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe("https://test.supabase.co/functions/v1/proposal-match");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer anon-key");
    expect(JSON.parse(init.body).lead.community).toBe("Alloy Coves");
    // Without a signal there is nothing to abort, so the timeout can't work.
    expect(init.signal).toBeDefined();
  });

  it("rejects with a named timeout once the ceiling passes, instead of hanging forever", async () => {
    const { matchLeadWithLLM } = await loadModule();
    vi.useFakeTimers();
    // A stalled edge function: resolves never, rejects only when aborted.
    global.fetch = vi.fn((_url, init) => new Promise((_res, rej) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        rej(e);
      });
    }));

    const p = matchLeadWithLLM(LEAD, { uvps: UVPS, painPoints: [] });
    const assertion = expect(p).rejects.toThrow(/proposal-match timed out after 60s/);
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
  });

  it("surfaces a non-2xx as an error the caller can fall back from", async () => {
    const { matchLeadWithLLM } = await loadModule();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502, json: () => Promise.resolve({}) });
    await expect(matchLeadWithLLM(LEAD, { uvps: UVPS, painPoints: [] })).rejects.toThrow("proposal-match 502");
  });

  it("surfaces an in-body error (the edge function's own 200-with-error shape)", async () => {
    const { matchLeadWithLLM } = await loadModule();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: () => Promise.resolve({ error: "ANTHROPIC_API_KEY not configured" }),
    });
    await expect(matchLeadWithLLM(LEAD, { uvps: UVPS, painPoints: [] }))
      .rejects.toThrow("ANTHROPIC_API_KEY not configured");
  });

  it("refuses to call out at all when Supabase is not configured", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    vi.resetModules();
    const { matchLeadWithLLM, LLM_ENABLED } = await import("./proposalLLM.js");
    global.fetch = vi.fn();
    expect(LLM_ENABLED).toBe(false);
    await expect(matchLeadWithLLM(LEAD, { uvps: UVPS, painPoints: [] })).rejects.toThrow(/disabled/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("realignFromTranscript", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("shares the same timeout ceiling — the realign modal blocks too", async () => {
    const { realignFromTranscript } = await loadModule();
    vi.useFakeTimers();
    global.fetch = vi.fn((_url, init) => new Promise((_res, rej) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        rej(e);
      });
    }));

    const p = realignFromTranscript({ id: "p1" }, { uvps: UVPS, transcript: "call notes" });
    const assertion = expect(p).rejects.toThrow(/proposal-realign timed out after 60s/);
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
  });
});

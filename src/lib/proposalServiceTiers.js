// ============================================================================
// "Services you're looking for" → a recommended tier, per CAM.
//
// This is the board's most direct statement of what they want, and until now the
// recommendation ignored it entirely (recommendTier read homes, budget, status and
// type; `services` was mapped at intake and dropped). Budget was carrying a job it
// is bad at: it is an OPTIONAL question about money, being used to infer scope.
//
// WHY A MAP INSTEAD OF KEYWORDS. Every CAM sells a different menu under different
// names, and their tier ladders differ too. So nothing here knows what a service
// is called or what tiers exist — both come from the CAM's profile
// (camProfiles.js → serviceTiers), which is one object per client:
//
//   serviceTiers: {
//     rank: ['financial', 'full', 'onsite'],   // low → high, this CAM's ladder
//     recommendable: ['full', 'onsite'],       // financial is a downsell: never auto
//     map: { 'On-site support': 'onsite', 'Vendor coordination': 'full', ... },
//   }
//
// THE RULE. Every ticked service implies a tier; the HIGHEST implied tier by rank
// wins. A board asking for three financial services plus board-meeting support is
// asking for full service — the most demanding thing they picked is what they
// need, and the tiers are supersets of each other. On-site outranks everything.
//
// THEN THE DOWNSELL RULE. If the winner is not in `recommendable`, it is promoted
// to the lowest recommendable tier AT OR ABOVE it — never demoted. For CMGT that
// means a board ticking only "Full financial management" is recommended
// Full-Service, because Financial & Administrative is a downsell CMGT does not
// open with. `promotedFrom` records what the answers actually implied so the
// cockpit can tell staff the downsell exists (see intakeFlags) rather than hiding
// it. The board never sees this; it is a sales lever, not a quote.
//
// MATCHING. Substring, not split. The value arrives comma-joined and the labels
// themselves contain punctuation ("Collections / delinquency", "Compliance &
// insurance"); PAIN_POINTS taught this lesson the expensive way — splitting on
// commas mangles labels that contain them. A map whose keys are substrings of each
// other would double-match, so proposalServiceTiers.test.js asserts no client's
// keys overlap that way.
// ============================================================================

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[‘’`]/g, "'")
  .replace(/[—–−]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

// Highest-ranked of `ids` per this CAM's ladder. Unknown ids rank lowest so a
// stale map entry can never outrank a real one.
export function highestTier(ids, rank) {
  let best = null;
  let bestAt = -1;
  ids.forEach((id) => {
    const at = rank.indexOf(id);
    if (at > bestAt) { best = id; bestAt = at; }
  });
  return bestAt >= 0 ? best : null;
}

// The lowest recommendable tier at or above `tierId`. Null when this CAM has
// nothing recommendable at or above it (a misconfiguration, handled by the
// caller rather than guessed at).
export function promote(tierId, { rank = [], recommendable = [] } = {}) {
  const at = rank.indexOf(tierId);
  if (at < 0) return null;
  if (recommendable.includes(tierId)) return tierId;
  for (let i = at + 1; i < rank.length; i += 1) {
    if (recommendable.includes(rank[i])) return rank[i];
  }
  return null;
}

// Which of this CAM's service labels the board's answer contains.
export function servicesMatched(servicesValue, serviceTiers) {
  const hay = norm(servicesValue);
  if (!hay || !serviceTiers?.map) return [];
  return Object.keys(serviceTiers.map).filter((label) => {
    const n = norm(label);
    return n && hay.includes(n);
  });
}

// The board's service answer → a tier recommendation, or null when there is no
// usable signal (nothing ticked, no map configured, nothing matched).
//
// Returns { tierId, impliedTierId, promotedFrom, matched, labels } where:
//   tierId        what to recommend (already promoted past any downsell tier)
//   impliedTierId what the answers literally implied, before the downsell rule
//   promotedFrom  set only when those differ — the downsell staff can offer
//   matched       the service labels found, for "why" copy
export function tierFromServices(servicesValue, serviceTiers) {
  if (!serviceTiers?.map || !Array.isArray(serviceTiers.rank) || !serviceTiers.rank.length) return null;
  const matched = servicesMatched(servicesValue, serviceTiers);
  if (!matched.length) return null;

  const implied = highestTier(matched.map((l) => serviceTiers.map[l]), serviceTiers.rank);
  if (!implied) return null;

  const recommendable = serviceTiers.recommendable && serviceTiers.recommendable.length
    ? serviceTiers.recommendable
    : serviceTiers.rank;                       // no policy configured: all are fair game
  const tierId = promote(implied, { rank: serviceTiers.rank, recommendable });
  if (!tierId) return null;                    // misconfigured ladder — say nothing

  return {
    tierId,
    impliedTierId: implied,
    promotedFrom: tierId !== implied ? implied : null,
    matched,
    // Only the labels that actually decided it, for the `why` line.
    labels: matched.filter((l) => serviceTiers.map[l] === implied),
  };
}

-- The facts the tier recommendation needs and the proposals table never kept.
--
-- 1. services — WHAT THE BOARD ACTUALLY ASKED FOR.
--
-- The intake form's "Services you're looking for" multi-select is the closest
-- thing to a direct answer about which tier a board wants, and it was the one
-- answer the recommendation ignored. leadToProposalRaw has always mapped it
-- (`services`), mintLead never wrote it, loadData never read it, and there was no
-- column to write it to — so it existed for the length of one mint and vanished.
--
-- That is not just a missed signal. Once services BECOMES the primary signal, a
-- proposal whose services are unknown re-derives to a different tier than the one
-- it was minted with, so any later edit in Build silently downgrades it — an
-- On-Site recommendation quietly becoming Full-Service because a staffer opened
-- "Edit details" and pressed save. The signal has to be as durable as the tier it
-- produced.
--
-- Stored as the raw submitted string (comma-joined labels, e.g.
-- "Full financial management, Collections / delinquency, On-site support") rather
-- than parsed. The labels are the client's own form vocabulary and the mapping
-- from label to tier lives per-CAM in src/lib/camProfiles.js → serviceTiers; a
-- lead keeps the words it was submitted with so a later mapping change reads
-- historical leads correctly instead of finding a value parsed under old rules.
--
-- 2. tier_manual — WHO CHOSE THE TIER.
--
-- The tier is re-derived whenever a lead's facts change, which is what stops a
-- stored tier describing facts that no longer hold (20260814: an 834-home board
-- that asked for financial-only sat stored as Full-Service, quoting $7,489/mo).
-- Correct while a stored tier could only ever be a derived value — there was no
-- tier picker in the UI, and saveDetails says so in a comment.
--
-- Build is getting one, because CMGT's Financial & Administrative tier is a
-- DOWNSELL: it must never be recommended automatically, and it must still be
-- reachable when a call establishes that is what the board wants. So a human
-- choice now exists and re-derivation would overwrite it on the next edit.
--
-- "Stored tier differs from derived tier" cannot be used to detect this — that is
-- exactly the 834-home condition too, and treating it as an override would
-- reintroduce the bug it replaced. The two cases are indistinguishable from the
-- data, so intent gets recorded explicitly.
--
-- Every column here is nullable with a safe default and nothing reads them until the
-- application code that follows is deployed, so this migration is orderable
-- before that deploy and is a no-op until then.

alter table public.proposals
  add column if not exists services text,
  add column if not exists tier_manual boolean not null default false,
  -- 3. amenities — the same gap as `services`, one line below it in
  -- proposalIntake.js: the board tells us they have a pool, a clubhouse, a gated
  -- entry, a marina, and the answer was mapped and then discarded. It does not
  -- feed the tier; it is context a CAM should be able to read on the card, and
  -- material a tailored proposal can eventually reference.
  add column if not exists amenities text;

comment on column public.proposals.services is
  'The intake form''s "Services you''re looking for" answer, as the raw comma-joined labels the board submitted. Primary input to the tier recommendation; mapped per-CAM in src/lib/camProfiles.js -> serviceTiers.';

comment on column public.proposals.tier_manual is
  'true when a human set tier_id in Build. Suppresses automatic re-derivation, which otherwise overwrites the choice on the next edit. Cleared when staff hand the tier back to the recommendation.';

comment on column public.proposals.amenities is
  'The intake form''s "Amenities" answer, as submitted. Context for the CAM and for tailoring a proposal; does not feed the tier recommendation.';

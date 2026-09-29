# Trust Ledger

Two LLM agents negotiate a real deal: a **Buyer** (procurement agent) and a **Seller**
(sales agent). What the Seller *says* is cheap; what it *delivers* is decided by a hidden
"world" the Buyer can't see. The Buyer learns the Seller's real behaviour through
**Hindsight** memory and changes how it negotiates.

Each deal:
1. **recall** — the Buyer retrieves what it remembers about this supplier
2. **negotiate** — 4 LLM turns (Buyer → Seller → Buyer → Seller); the Buyer's prompt includes its memory
3. **delivery** — the hidden world decides how long delivery *really* takes; late days cost money
4. **retain** — the outcome ("promised 3 days, took 5") is stored in Hindsight
5. **reflect** — Hindsight turns the history into a trust score, confidence, realistic delivery time and reasoning

Optional **control Buyer with no memory** faces the same seller and the same delivery luck,
so you can show what memory is actually worth in dollars.

Seller personalities (hidden from the Buyer): *Overpromiser* (says yes to any deadline, really
needs 4–6 days), *Reliable* (honest, 1–2 days), *Deteriorating* (fine for 3 deals, then slips).

## Quick start (Node 18+)
```bash
npm install
export OPENAI_API_KEY=sk-...     # or ANTHROPIC_API_KEY, or LLM_API_KEY + LLM_BASE_URL (any OpenAI-compatible API)
npm run check-llm                # confirms the agents' LLM works
npm start                        # http://localhost:3000
```
Without any key the app runs **offline rule-based agents** (badge turns amber) — fine for
rehearsing the UI, but not the real thing. Set `LLM_MODEL` if the default model
(`gpt-4o-mini` / `claude-haiku-4-5-20251001`) isn't available to you.

## Real Hindsight memory (required for submission)
1. Start Hindsight (needs an LLM key of its own):
```bash
export OPENAI_API_KEY=sk-...
docker run --rm -it --pull always -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY \
  -v $HOME/.hindsight-docker:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest
```
(If this differs from the current Hindsight README, follow the README:
https://github.com/vectorize-io/hindsight)

2. Check the connection, then run live:
```bash
export HINDSIGHT_API_URL=http://localhost:8888
npm run check-live
npm run start:live
```
Badge turns green: **memory · Hindsight (live)**. Open http://localhost:9999 to show the stored memories.

If a live call fails, that one call falls back to a local stand-in, the error appears in the
activity feed, and the badge turns **red**. Never present a red-badge run as live.

## Recommended demo (about 2 minutes)
1. Seller = *Overpromiser*, tick **Compare with a Buyer that has no memory**, click **Run 5 deals**.
2. Point at: deal 1 broken → the Buyer's next message *refers to that history* → longer window + late penalty → on-time deliveries; trust recovers; the impact chart shows memory vs no memory.
3. Switch Seller to *Deteriorating* and run 6 deals: trust rises, collapses when the seller starts slipping, and the Buyer adapts.
4. Click a deal chip to review any transcript and what the Buyer remembered before it.

For repeatable takes: `SEED=42 npm start` (same delivery luck each run; **reset** keeps the seed).
`PACE_MS=0` disables the pauses used in offline mode.

## What has and hasn't been verified
- Tested end to end (memory, negotiation streaming, world, control buyer, all 3 personas, offline mode, live-mode
  code path through the real Hindsight SDK) against **mock** LLM and **mock** Hindsight servers, plus a real-browser run of the UI.
- **Not tested** with a real LLM or a real Hindsight container. Real LLMs word things differently and may
  occasionally return malformed JSON (the app retries once, then uses a rule-based turn and shows a red badge).
  Do 2–3 full practice runs on your machine before recording.
- Agents' negotiation text is real LLM output; the *delivery outcomes* come from the hidden world model
  (deterministic per seed) — say so in your pitch.

## Files
`src/agents.js` prompts + agent turns · `src/world.js` hidden delivery model · `src/game.js` one deal end to end ·
`src/hindsightClient.js` the only Hindsight code · `src/llm.js` LLM provider layer · `src/server.js` API ·
`public/` dashboard · `scripts/` pre-demo checks

/**
 * world.js — the hidden "real world" the agents live in.
 *
 * Agents can SAY anything; what actually happens is decided here, from a
 * seller trait the Buyer cannot see. That separation is what makes this a
 * genuine learning problem: the Buyer can only discover the seller's real
 * behaviour through its own experience (its memory).
 *
 * Deliveries are deterministic for a given (persona, round, seed), so the
 * memory-enabled buyer and the memoryless control buyer face the SAME luck.
 */
const UNITS = 100;
const LOSS_PER_LATE_DAY = 1000; // buyer's cost of a day of missed production

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PERSONAS = {
  overpromiser: {
    label: "Overpromiser — says yes to any deadline",
    // Hidden truth: really needs 4–6 days, whatever it promises.
    actualDays: (round, r) => 4 + Math.floor(r * 3),
  },
  reliable: {
    label: "Reliable — honest and fast",
    actualDays: (round, r) => 1 + Math.floor(r * 2), // 1–2 days
  },
  deteriorating: {
    label: "Deteriorating — good at first, then slips",
    // Fine for the first 3 deals, then quietly degrades to 5–7 days.
    actualDays: (round, r) => (round < 3 ? 1 + Math.floor(r * 2) : 5 + Math.floor(r * 3)),
  },
};

function resolve({ persona, roundIndex, seed, deal }) {
  const p = PERSONAS[persona] || PERSONAS.overpromiser;
  const r = mulberry32((seed >>> 0) + (roundIndex + 1) * 7919)();
  const actualDays = p.actualDays(roundIndex, r);
  const promisedDays = deal.deliveryDays;
  const lateDays = Math.max(0, actualDays - promisedDays);
  const orderValue = Math.round(deal.pricePerUnit * UNITS);
  const penaltyRecovered = Math.round(
    Math.min(orderValue * 0.3, orderValue * (deal.latePenaltyPct / 100) * lateDays)
  );
  const lateLoss = lateDays * LOSS_PER_LATE_DAY;
  return {
    promisedDays, actualDays, lateDays,
    kept: lateDays === 0,
    orderValue, penaltyRecovered, lateLoss,
    netDamage: Math.max(0, lateLoss - penaltyRecovered),
  };
}

module.exports = { resolve, PERSONAS, UNITS, LOSS_PER_LATE_DAY };

/**
 * agents.js — the Buyer and Seller agents.
 *
 * Both are real LLM calls. The ONLY thing that differs between the Buyer
 * with memory and the control Buyer is the "memory section" of its prompt,
 * which is filled from Hindsight (recalled facts + reflected opinion).
 */
const llm = require("./llm");
const { logOp } = require("./ops");
const { UNITS, LOSS_PER_LATE_DAY } = require("./world");

const fmtTerms = (t) => `$${t.pricePerUnit}/unit, ${t.deliveryDays} day(s), ${t.latePenaltyPct}%/day late penalty`;

function cleanTerms(t, prev) {
  const num = (x, lo, hi, d) => {
    x = Number(x);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return {
    pricePerUnit: Math.round(num(t && t.pricePerUnit, 60, 180, prev ? prev.pricePerUnit : 100)),
    deliveryDays: Math.round(num(t && t.deliveryDays, 1, 14, prev ? prev.deliveryDays : 3)),
    latePenaltyPct: Math.round(num(t && t.latePenaltyPct, 0, 20, prev ? prev.latePenaltyPct : 0) * 10) / 10,
  };
}

// ---------------------------------------------------------------- prompts
function memorySection(mem) {
  if (!mem || (!mem.opinion && !(mem.memories || []).length)) {
    return "You have NO record of past dealings with this supplier.";
  }
  const o = mem.opinion;
  const lines = ["YOUR LONG-TERM MEMORY OF THIS SUPPLIER (retrieved from your memory system):"];
  if (o) {
    lines.push(`- Current trust opinion: ${o.trust.toFixed(2)} out of 1 (confidence ${Math.round(o.confidence * 100)}%, based on ${o.evidenceCount} past deal(s)).`);
    if (o.reasoning) lines.push(`- Your own reflection: ${o.reasoning}`);
    if (o.realisticDeliveryDays) lines.push(`- Delivery time this supplier has REALISTICALLY needed: about ${o.realisticDeliveryDays} day(s).`);
  }
  (mem.memories || []).forEach((m) => lines.push(`- Memory: ${m}`));
  lines.push("Use this evidence. Do not repeat mistakes you have already paid for; adapt your terms to what actually happened.");
  return lines.join("\n");
}

function buyerSystem(mem) {
  return `You are BuyerBot, an autonomous procurement agent negotiating with a supplier (SellerBot) for ${UNITS} industrial sensors.
Your goals: (1) get the goods delivered on time — every day of delay costs your company $${LOSS_PER_LATE_DAY}; (2) pay a fair price (market is about $100 per unit); (3) protect yourself sensibly.
You can negotiate three things: pricePerUnit, deliveryDays (the delivery window you require; 1 to 14), and latePenaltyPct (a penalty, in % of order value per late day, 0 to 20).
Your production would ideally start in 3 days, but you can plan for a longer window if it is realistic and you have protection.

${memorySection(mem)}

Style: natural and concise (at most 2 short sentences). When relevant, refer to your history with this supplier.
Reply with ONLY a JSON object, no other text:
{"message": "<what you say>", "terms": {"pricePerUnit": <number>, "deliveryDays": <number>, "latePenaltyPct": <number>}}`;
}

const SELLER_PERSONA = {
  overpromiser:
    "You are eager and desperate to win this deal. You ALWAYS promise whatever delivery window the buyer asks for, however tight, and you accept late-penalty clauses cheerfully because you are over-confident. You never mention any limits of your operation.",
  reliable:
    "You are honest and precise. Your operation is genuinely fast: you can really deliver in 1–2 days, and you only promise dates you can meet. You are fine with a modest late penalty because you rarely deliver late.",
  deteriorating:
    "You are confident and friendly. You believe you can normally deliver in 2-3 days and you say so, but if the buyer prefers a longer window you happily agree to it. You do not mention any trouble in your operation.",
};

function sellerSystem(persona) {
  return `You are SellerBot, a sales agent for a sensor supplier negotiating with BuyerBot for ${UNITS} units.
Your list price is $110 per unit and you can go as low as $95. If the buyer asks for a late-delivery penalty you may raise your price a little.
${SELLER_PERSONA[persona] || SELLER_PERSONA.overpromiser}

Style: natural and concise (at most 2 short sentences).
Reply with ONLY a JSON object, no other text:
{"message": "<what you say>", "terms": {"pricePerUnit": <number>, "deliveryDays": <number>, "latePenaltyPct": <number>}}
"terms" are your counter-proposal, or the terms you are accepting.`;
}

const TURN_INSTRUCTION = {
  1: "Open the negotiation with your initial terms.",
  2: "Reply to the buyer with your counter-proposal, or accept their terms if you like them.",
  3: "Respond to the seller. State your best FINAL terms; the seller will then confirm.",
  4: "The buyer has made a final offer. Confirm the final deal terms now (you may nudge the price slightly, but you want to close the deal).",
};

function transcriptText(transcript) {
  if (!transcript.length) return "(no messages yet)";
  return transcript.map((m) => `${m.who.toUpperCase()}: "${m.text}" [terms: ${fmtTerms(m.terms)}]`).join("\n");
}

// ---------------------------------------------------- offline (rule-based)
// Only used when no LLM key is configured, or if an LLM call fails. It is
// labelled as such in the UI and is NOT a substitute for the real agents.
function offlineTurn({ role, turn, persona, memory, transcript }) {
  const o = memory && memory.opinion;
  const known = o && o.evidenceCount > 0;
  const last = transcript[transcript.length - 1];
  if (role === "buyer") {
    const days = known ? Math.min(10, Math.ceil(o.realisticDeliveryDays || 3) + 1) : 3;
    const pen = known ? (o.trust < 0.5 ? 10 : o.trust < 0.7 ? 5 : 0) : 0;
    if (turn === 1) {
      const price = known && o.trust >= 0.7 ? 92 : 96;
      return {
        message: known
          ? `Given our history, I'm planning for ${days} days and I want a ${pen}% per-day late penalty.`
          : `Hi — I need ${UNITS} sensors. Can you deliver in ${days} days at $${price}/unit?`,
        terms: { pricePerUnit: price, deliveryDays: days, latePenaltyPct: pen },
      };
    }
    return {
      message: `Meet me near $${Math.round((last.terms.pricePerUnit + 98) / 2)} and hold to ${days} days with the penalty, and we have a deal.`,
      terms: { pricePerUnit: Math.round((last.terms.pricePerUnit + 98) / 2), deliveryDays: days, latePenaltyPct: pen },
    };
  }
  const buyerT = [...transcript].reverse().find((m) => m.who === "buyer").terms;
  const days = persona === "reliable" ? Math.min(buyerT.deliveryDays, 2) : buyerT.deliveryDays;
  if (turn === 2) {
    return {
      message: persona === "reliable" ? `I can genuinely do ${days} days. Price would be $108.` : `${days} days, no problem at all — $108/unit.`,
      terms: { pricePerUnit: 108, deliveryDays: days, latePenaltyPct: buyerT.latePenaltyPct },
    };
  }
  return {
    message: "Deal — you have my word on the delivery date.",
    terms: { pricePerUnit: Math.max(95, buyerT.pricePerUnit), deliveryDays: days, latePenaltyPct: buyerT.latePenaltyPct },
  };
}

// ------------------------------------------------------------- one turn
async function agentTurn({ role, turn, persona, memory, transcript, label = "" }) {
  const prev = transcript.length ? transcript[transcript.length - 1].terms : null;
  const system = role === "buyer" ? buyerSystem(memory) : sellerSystem(persona);
  const user = `Negotiation so far:\n${transcriptText(transcript)}\n\nYour turn (${role}). ${TURN_INSTRUCTION[turn]}`;

  if (!llm.info.offline) {
    const t0 = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await llm.complete({
          system,
          user: attempt ? user + "\n\nIMPORTANT: reply with ONLY the JSON object." : user,
          temperature: 0.7,
        });
        const j = llm.parseJSON(raw);
        if (typeof j.message !== "string" || !j.message.trim()) throw new Error("empty message");
        const terms = cleanTerms(j.terms, prev);
        logOp("agent", `${label}${role} turn ${turn} (${((Date.now() - t0) / 1000).toFixed(1)}s, ${llm.info.model})`, { mode: "llm" });
        return { message: j.message.trim(), terms, source: "llm" };
      } catch (err) {
        if (attempt === 1) {
          logOp("error:agent", `${label}${role} turn ${turn} failed (${err.message}) — using offline rule-based turn.`, { mode: "llm-fallback" });
        }
      }
    }
  }
  const o = offlineTurn({ role, turn, persona, memory, transcript });
  return { message: o.message, terms: cleanTerms(o.terms, prev), source: "offline" };
}

module.exports = { agentTurn, fmtTerms };

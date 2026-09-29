/**
 * hindsightClient.js — the ONLY file that talks to Hindsight.
 *
 *   HINDSIGHT_MODE    = "live" | "demo"   (default "demo")
 *   HINDSIGHT_API_URL = http://localhost:8888   (live mode)
 *
 * LIVE: real retain / recall / reflect against a running Hindsight server.
 * DEMO: a small local stand-in with the same shape, for rehearsal only.
 * The app never needs to know which one it is talking to.
 */
const { logOp, getOpsLog, clearOpsLog } = require("./ops");

const MODE = process.env.HINDSIGHT_MODE || "demo";
const API_URL = process.env.HINDSIGHT_API_URL || "http://localhost:8888";

// ---------------------------------------------------------------- LIVE
// Signatures verified against @vectorize-io/hindsight-client 0.10.x:
// retain(bankId, content, opts), recall(bankId, query), reflect(bankId, query, {responseSchema}).
let _client = null;
function getClient() {
  if (!_client) {
    const { HindsightClient } = require("@vectorize-io/hindsight-client");
    _client = new HindsightClient({ baseUrl: API_URL });
  }
  return _client;
}

// Makes reflect() return NUMBERS we can chart, not just prose.
const TRUST_SCHEMA = {
  type: "object",
  properties: {
    trust: { type: "number", minimum: 0, maximum: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidenceCount: { type: "integer", minimum: 0 },
    realisticDeliveryDays: { type: "number", minimum: 0, maximum: 30 },
    reasoning: { type: "string" },
  },
  required: ["trust", "confidence", "evidenceCount"],
};

const _readyBanks = new Set();
async function ensureBank(bankId) {
  if (_readyBanks.has(bankId)) return;
  try {
    await getClient().createBank(bankId, {
      reflectMission:
        "You assess how reliable a supplier is, based only on whether its delivery promises to a buyer were kept, and how long deliveries really take compared with what was promised.",
    });
  } catch (_) { /* already exists / auto-created on retain */ }
  _readyBanks.add(bankId);
}

const bankOf = ({ userId, memoryBankId }) => `${memoryBankId}-${userId}`;

async function liveRetain(args) {
  const bankId = bankOf(args);
  await ensureBank(bankId);
  logOp("retain", args.text, { bankId, mode: "live" });
  const meta = {}; // Hindsight metadata values must be strings
  for (const [k, v] of Object.entries(args.metadata || {})) meta[k] = String(v);
  return getClient().retain(bankId, args.text, { metadata: meta, context: "supplier delivery outcome" });
}

async function liveRecall(args) {
  const bankId = bankOf(args);
  const res = await getClient().recall(bankId, args.query);
  const memories = (res.results || []).map((r) => r.text).filter(Boolean).slice(0, 6);
  logOp("recall", `${args.query} → ${memories.length} memor${memories.length === 1 ? "y" : "ies"}`, { bankId, mode: "live" });
  return { memories, opinion: null };
}

async function liveReflect(args) {
  const bankId = bankOf(args);
  logOp("reflect", "Forming an updated trust opinion from the full history…", { bankId, mode: "live" });
  const result = await getClient().reflect(
    bankId,
    "Based on every past deal with this supplier, what trust score (0 = never trust, 1 = fully trust) should we give them now? " +
      "Also give your confidence (0-1), how many deals of evidence exist, how many days they REALISTICALLY need to deliver " +
      "(realisticDeliveryDays, from actual deliveries, not promises, weighting the most recent deliveries most heavily), and a one-sentence reasoning.",
    { responseSchema: TRUST_SCHEMA, budget: "low" }
  );
  const raw = result.structured_output;
  if (!raw || typeof raw.trust !== "number") {
    throw new Error(result.structured_output_error || "reflect returned no structured trust score (check the LLM key/model in the Hindsight container)");
  }
  const clamp = (n) => Math.max(0, Math.min(1, Number(n)));
  const opinion = {
    trust: Number(clamp(raw.trust).toFixed(3)),
    confidence: Number(clamp(raw.confidence ?? 0).toFixed(3)),
    evidenceCount: Number.isFinite(raw.evidenceCount) ? raw.evidenceCount : 0,
    reasoning: raw.reasoning || "",
  };
  if (Number.isFinite(raw.realisticDeliveryDays) && raw.realisticDeliveryDays > 0) {
    opinion.realisticDeliveryDays = Number(raw.realisticDeliveryDays.toFixed(1));
  }
  logOp("reflect:result", opinion.reasoning || "(no reasoning returned)", { bankId, mode: "live", opinion });
  return opinion;
}

// ---------------------------------------------------------------- DEMO
const fs = require("fs");
const path = require("path");
const STORE_PATH = path.join(__dirname, "..", "data", "memory-store.json");
const loadStore = () => (fs.existsSync(STORE_PATH) ? JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) : {});
const saveStore = (s) => {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(s, null, 2));
};

async function demoRetain(args) {
  const store = loadStore();
  const key = bankOf(args);
  const meta = {}; // same as live: metadata values are strings
  for (const [k, v] of Object.entries(args.metadata || {})) meta[k] = String(v);
  (store[key] ||= { memories: [] }).memories.push({ text: args.text, metadata: meta, ts: Date.now() });
  saveStore(store);
  if (!args.quiet) logOp("retain", args.text, { bankId: key, mode: "demo" });
  return { ok: true };
}

async function demoRecall(args) {
  const key = bankOf(args);
  const bank = loadStore()[key] || { memories: [] };
  const memories = bank.memories.map((m) => m.text).slice(-6);
  logOp("recall", `${args.query} → ${memories.length} memor${memories.length === 1 ? "y" : "ies"}`, { bankId: key, mode: "demo" });
  return { memories, opinion: null };
}

async function demoReflect(args) {
  const key = bankOf(args);
  const bank = loadStore()[key] || { memories: [] };
  logOp("reflect", "Forming an updated trust opinion from the full history…", { bankId: key, mode: "demo" });

  const deals = bank.memories.map((m) => m.metadata).filter((m) => m && m.kept !== undefined);
  if (!deals.length) {
    const op = { trust: 0.5, confidence: 0, evidenceCount: 0, reasoning: "No history yet — neutral baseline." };
    logOp("reflect:result", op.reasoning, { bankId: key, mode: "demo", opinion: op });
    return op;
  }
  let trust = 0.5; // each deal nudges trust toward 1 (kept) or 0 (broken)
  deals.forEach((d) => { trust += 0.4 * ((d.kept === "true" ? 1 : 0) - trust); });
  const kept = deals.filter((d) => d.kept === "true").length;
  const avgOf = (arr, k) => arr.reduce((s, d) => s + Number(d[k] || 0), 0) / arr.length;
  const recent = deals.slice(-3); // recent deliveries matter most when a supplier's behaviour changes
  const op = {
    trust: Number(trust.toFixed(3)),
    confidence: Number(Math.min(0.95, 0.2 + deals.length * 0.15).toFixed(3)),
    evidenceCount: deals.length,
    realisticDeliveryDays: Number(avgOf(recent, "actualDays").toFixed(1)),
    reasoning: `${kept} of ${deals.length} deal${deals.length === 1 ? "" : "s"} delivered as promised; the last ${recent.length} promised ${avgOf(recent, "promisedDays").toFixed(1)} days on average but really took ${avgOf(recent, "actualDays").toFixed(1)}.`,
  };
  logOp("reflect:result", op.reasoning, { bankId: key, mode: "demo", opinion: op });
  return op;
}

// ------------------------------------------------------------- PUBLIC API
// In LIVE mode a failed call falls back to the local stand-in FOR THAT CALL,
// logs the error loudly, and the dashboard badge turns red. It never fails
// silently, and a red-badge run must not be presented as live.
async function guarded(name, live, demo, args) {
  if (MODE !== "live") return demo(args);
  try {
    const res = await live(args);
    // Mirror retains into the local store (silently) so that, if a later live
    // call fails, the fallback still has the real history to work from.
    if (name === "retain") await demoRetain({ ...args, quiet: true });
    return res;
  } catch (err) {
    logOp(`error:${name}`, `Live Hindsight ${name} failed (${err.message}) — falling back to the local stand-in for this call.`, { mode: "live-fallback" });
    return demo(args);
  }
}

module.exports = {
  mode: MODE,
  apiUrl: API_URL,
  getOpsLog,
  clearOpsLog,
  retain: (a) => guarded("retain", liveRetain, demoRetain, a),
  recall: (a) => guarded("recall", liveRecall, demoRecall, a),
  reflect: (a) => guarded("reflect", liveReflect, demoReflect, a),
};

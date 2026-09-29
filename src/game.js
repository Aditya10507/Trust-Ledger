/**
 * game.js — runs one deal end to end and keeps the state of the run.
 *
 * One deal:  recall → negotiate (4 LLM turns) → real delivery (hidden world)
 *            → retain the outcome → reflect into an updated trust opinion.
 * Optional:  a control Buyer with NO memory faces the same seller and the
 *            same delivery luck, to show what memory is actually worth.
 */
const hindsight = require("./hindsightClient");
const llm = require("./llm");
const world = require("./world");
const { agentTurn } = require("./agents");
const { getOpsLog, clearOpsLog } = require("./ops");

const SELLER_ID = "supplier";
const PACE = Number(process.env.PACE_MS ?? (llm.info.offline ? 700 : 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pace = (on = true) => (PACE && on ? sleep(PACE) : Promise.resolve());

let run;
function newRun({ persona, compare, seed } = {}) {
  run = {
    persona: world.PERSONAS[persona] ? persona : "overpromiser",
    compare: !!compare,
    seed: Number.isFinite(Number(seed)) ? Number(seed) : Number(process.env.SEED) || Math.floor(Math.random() * 1e9),
    runId: Date.now().toString(36),
    rounds: [], control: [], lastOpinion: null, busy: false,
  };
  clearOpsLog();
}
newRun();

const bankId = () => `trust-ledger-${run.runId}`;

async function negotiate({ memory, emit, paced, label }) {
  const transcript = [];
  for (let turn = 1; turn <= 4; turn++) {
    const role = turn % 2 ? "buyer" : "seller";
    emit({ type: "typing", who: role });
    const r = await agentTurn({ role, turn, persona: run.persona, memory, transcript, label });
    const msg = { who: role, turn, text: r.message, terms: r.terms, source: r.source };
    transcript.push(msg);
    emit({ type: "message", ...msg });
    await pace(paced);
  }
  return transcript;
}

async function playOne({ roundIndex, useMemory, emit, paced }) {
  let memory = null;
  if (useMemory) {
    emit({ type: "stage", stage: "recall", text: "Buyer consults its memory…" });
    const rec = await hindsight.recall({
      userId: SELLER_ID, memoryBankId: bankId(),
      query: "What do I know about this supplier's delivery reliability and past promises?",
    });
    memory = { opinion: run.lastOpinion, memories: rec.memories || [] };
    emit({ type: "memory", memory });
    await pace(paced);
  }

  emit({ type: "stage", stage: "negotiate", text: "Negotiating the deal…" });
  const transcript = await negotiate({ memory, emit, paced, label: useMemory ? "" : "[no-memory control] " });
  const deal = transcript[transcript.length - 1].terms;
  emit({ type: "deal", deal });

  emit({ type: "stage", stage: "deliver", text: "Order placed — waiting for delivery…" });
  await pace(paced); await pace(paced);
  const outcome = world.resolve({ persona: run.persona, roundIndex, seed: run.seed, deal });
  emit({ type: "outcome", outcome });

  let opinionAfter = null;
  if (useMemory) {
    const o = outcome;
    const text =
      `Deal ${roundIndex + 1}: the supplier promised delivery in ${o.promisedDays} day(s) at $${deal.pricePerUnit}/unit` +
      (deal.latePenaltyPct ? ` with a ${deal.latePenaltyPct}%/day late penalty` : "") +
      `. Actual delivery took ${o.actualDays} day(s)` +
      (o.lateDays ? ` — ${o.lateDays} day(s) late, promise broken.` : " — on time, promise kept.");
    emit({ type: "stage", stage: "retain", text: "Retaining this outcome in memory…" });
    await hindsight.retain({
      userId: SELLER_ID, memoryBankId: bankId(), text,
      metadata: { round: roundIndex + 1, promisedDays: o.promisedDays, actualDays: o.actualDays, lateDays: o.lateDays, kept: o.kept },
    });
    emit({ type: "stage", stage: "reflect", text: "Reflecting on the full history…" });
    opinionAfter = await hindsight.reflect({ userId: SELLER_ID, memoryBankId: bankId() });
    run.lastOpinion = opinionAfter;
    emit({ type: "opinion", opinion: opinionAfter });
  }
  return { round: roundIndex + 1, transcript, memory, deal, outcome, opinionAfter };
}

async function playNext(emit) {
  if (run.busy) throw new Error("A deal is already in progress");
  run.busy = true;
  try {
    const roundIndex = run.rounds.length;
    const jobs = [playOne({ roundIndex, useMemory: true, emit, paced: true })];
    if (run.compare) jobs.push(playOne({ roundIndex, useMemory: false, emit: () => {}, paced: false }).catch(() => null));
    const [main, control] = await Promise.all(jobs);
    run.rounds.push(main);
    if (run.compare) {
      run.control.push(control);
      emit({ type: "control", control });
    }
    emit({ type: "done", state: getState() });
  } finally {
    run.busy = false;
  }
}

function getState() {
  return {
    config: { persona: run.persona, compare: run.compare, seed: run.seed },
    personas: Object.fromEntries(Object.entries(world.PERSONAS).map(([k, v]) => [k, v.label])),
    mode: { memory: hindsight.mode, llm: llm.info },
    rounds: run.rounds, control: run.control, opinion: run.lastOpinion,
    ops: getOpsLog().slice(-40), busy: run.busy,
    limits: { unitPrice: 100, lossPerLateDay: world.LOSS_PER_LATE_DAY },
  };
}

function configure({ persona, compare, keepSeed }) {
  const seed = keepSeed && persona === run.persona ? run.seed : undefined;
  newRun({ persona, compare, seed });
}

function reset() {
  newRun({ persona: run.persona, compare: run.compare, seed: run.seed }); // same luck → repeatable takes
}

module.exports = { playNext, getState, configure, reset, isBusy: () => run.busy };

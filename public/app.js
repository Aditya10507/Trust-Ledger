const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UNITS = 100;

let S = null;            // latest full state from the server
let view = null;         // index of the deal shown in the room
let liveMode = false;    // a deal is streaming right now
let stopAfter = false;
let lastFailed = false;
let pendingDelta = null;

// ------------------------------------------------------------ small views
const termsChips = (t) =>
  `<div class="terms"><span>$${t.pricePerUnit}/unit</span><span>${plural(t.deliveryDays, "day")}</span>` +
  (t.latePenaltyPct ? `<span class="pen">${t.latePenaltyPct}%/day late penalty</span>` : `<span>no late penalty</span>`) + `</div>`;

function msgHTML(m) {
  const isB = m.who === "buyer";
  return `<div class="msg ${m.who}"><div class="avatar">${isB ? "B" : "S"}</div><div class="bubble">
    <div class="who">${isB ? "Buyer" : "Seller"}${m.source === "offline" ? '<span class="tag-offline">rule-based</span>' : ""}</div>
    <div class="text">${esc(m.text)}</div>${termsChips(m.terms)}</div></div>`;
}

function dealHTML(d) {
  return `<div class="deal-title">Deal closed</div><div class="row">
    <div><span class="k">Order value</span><span class="v">${money(d.pricePerUnit * UNITS)}</span></div>
    <div><span class="k">Price</span><span class="v">$${d.pricePerUnit}/unit</span></div>
    <div><span class="k">Delivery promised</span><span class="v">${plural(d.deliveryDays, "day")}</span></div>
    <div><span class="k">Late penalty</span><span class="v">${d.latePenaltyPct}%/day</span></div></div>`;
}

function deliveryHTML(o) {
  const max = Math.max(8, o.promisedDays, o.actualDays) + 1;
  const pos = (d) => (d / max) * 100;
  let ticks = "";
  for (let d = 0; d <= max; d++) ticks += `<span class="tick" style="left:${pos(d)}%">${d}</span>`;
  const late = o.lateDays > 0;
  const cost = late
    ? `Cost of delay ${money(o.lateLoss)}${o.penaltyRecovered ? ` − penalty recovered ${money(o.penaltyRecovered)}` : ""} = <b>${money(o.netDamage)}</b> net damage`
    : `No delay, no damage.`;
  return `<div class="delivery-head">Delivery — days since the order</div>
    <div class="timeline" data-p="${pos(o.promisedDays)}" data-a="${pos(o.actualDays)}" data-late="${late ? 1 : 0}">
      <div class="track"><div class="fill"></div><div class="latefill" style="left:${pos(o.promisedDays)}%"></div></div>
      ${ticks}<div class="flag" style="left:${pos(o.promisedDays)}%">promised: day ${o.promisedDays}</div>
      <div class="truck ${late ? "late" : ""}"></div></div>
    <div class="delivery-summary">Promised <b>${plural(o.promisedDays, "day")}</b> · delivered in <b>${plural(o.actualDays, "day")}</b> ·
      ${late ? `<span class="late">${plural(o.lateDays, "day")} late — promise broken</span>` : `<span class="ontime">on time — promise kept</span>`}<br/>${cost}</div>`;
}

function animateDelivery(animate) {
  const tl = document.querySelector("#deliveryCard .timeline");
  if (!tl) return;
  const p = +tl.dataset.p, a = +tl.dataset.a, late = tl.dataset.late === "1";
  const fill = tl.querySelector(".fill"), lf = tl.querySelector(".latefill"), truck = tl.querySelector(".truck");
  const apply = () => {
    fill.style.width = (late ? p : a) + "%";
    lf.style.width = late ? a - p + "%" : "0%";
    truck.style.left = a + "%";
  };
  if (animate) requestAnimationFrame(() => requestAnimationFrame(apply));
  else { [fill, lf, truck].forEach((e) => (e.style.transition = "none")); apply(); }
}

function setStatus(text, err = false) {
  const el = $("statusLine");
  el.textContent = text;
  el.className = "status" + (err ? " err" : "");
}

// --------------------------------------------------------------- the room
function showRecord(r) {
  $("roomTitle").textContent = `Deal ${r.round}`;
  $("chat").innerHTML = r.transcript.map(msgHTML).join("");
  $("dealCard").hidden = false; $("dealCard").innerHTML = dealHTML(r.deal);
  $("deliveryCard").hidden = false; $("deliveryCard").innerHTML = deliveryHTML(r.outcome);
  animateDelivery(false);
  renderMemory(r.memory, r.round);
  setStatus(r.outcome.kept ? "Delivered as promised." : "The Seller broke its promise.");
}

function showEmptyRoom() {
  $("roomTitle").textContent = "Negotiation room";
  $("chat").innerHTML = `<div class="empty-state">The Buyer needs 100 sensors. The Seller wants the order.<br/>Run a deal to watch them negotiate.</div>`;
  $("dealCard").hidden = true; $("deliveryCard").hidden = true;
  renderMemory(null, 1);
  setStatus("Ready — run the first deal.");
}

function startLive() {
  liveMode = true; view = null; lastFailed = false;
  $("roomTitle").textContent = `Deal ${S.rounds.length + 1}`;
  $("chat").innerHTML = ""; $("dealCard").hidden = true; $("deliveryCard").hidden = true;
  setStatus("Starting…"); renderChips();
}

function showTyping(who) {
  removeTyping();
  const isB = who === "buyer";
  $("chat").insertAdjacentHTML("beforeend",
    `<div class="msg ${who} typing-row"><div class="avatar">${isB ? "B" : "S"}</div><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>`);
}
const removeTyping = () => document.querySelectorAll(".typing-row").forEach((e) => e.remove());

function renderChips() {
  const chips = S.rounds.map((r, i) =>
    `<button class="chip ${r.outcome.kept ? "kept" : "broken"} ${view === i && !liveMode ? "active" : ""}" data-i="${i}">#${r.round} ${r.outcome.kept ? "✓" : "✗"}</button>`).join("");
  $("roundChips").innerHTML = chips + (liveMode ? `<span class="chip livechip">#${S.rounds.length + 1} live</span>` : "");
}

// ------------------------------------------------------------ side panels
const trustColor = (t) => (t >= 0.7 ? "#2F6B3E" : t >= 0.45 ? "#A67C3D" : "#9A3324");

function stanceFor(op) {
  if (!op || !op.evidenceCount) return "No history yet — the Buyer negotiates blind.";
  const plan = op.realisticDeliveryDays ? ` It now plans for about ${Math.ceil(op.realisticDeliveryDays)} days.` : "";
  if (op.trust >= 0.7) return "Trusting — pushes for a better price, lighter protections." + plan;
  if (op.trust >= 0.45) return "Cautious — standard terms with some protection." + plan;
  return "Guarded — expects slippage and asks for late-penalty protection." + plan;
}

function renderSparkline(series) {
  const svg = $("sparkline");
  if (!series.length) { svg.innerHTML = ""; return; }
  const w = 240, h = 100, pad = 8;
  const y = (v) => h - pad - v * (h - pad * 2);
  const step = series.length > 1 ? (w - pad * 2) / (series.length - 1) : 0;
  const pts = series.map((v, i) => [pad + i * step, y(v)]);
  const c = trustColor(series[series.length - 1]);
  const guide = (t, label) => `<line x1="0" x2="${w}" y1="${y(t)}" y2="${y(t)}" stroke="#4A5A4F" stroke-opacity=".35" stroke-dasharray="3 3"/>
    <text x="${w - 2}" y="${y(t) - 3}" font-size="7" text-anchor="end" fill="#4A5A4F" font-family="IBM Plex Mono, monospace">${label}</text>`;
  svg.innerHTML = guide(0.7, "high") + guide(0.45, "neutral") +
    `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${c}" stroke-width="2"/>` +
    pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.6" fill="${c}"/>`).join("");
}

function renderTrust(op, series, delta = null) {
  const has = op && op.evidenceCount > 0;
  const t = has ? op.trust : 0.5;
  $("trustValue").textContent = has ? t.toFixed(2) : "—";
  $("trustValue").style.color = has ? trustColor(t) : "#4A5A4F";
  $("gaugeFill").style.width = has ? `${Math.round(t * 100)}%` : "0%";
  $("gaugeFill").style.background = trustColor(t);
  $("stanceText").textContent = stanceFor(op);
  $("evidenceCount").textContent = plural(has ? op.evidenceCount : 0, "deal");
  $("confidenceValue").textContent = has ? `${Math.round(op.confidence * 100)}%` : "0%";
  $("realisticDays").textContent = has && op.realisticDeliveryDays ? `~${op.realisticDeliveryDays} days` : "—";
  renderSparkline(series);
  const d = $("trustDelta");
  if (delta !== null && Math.abs(delta) >= 0.005) {
    d.textContent = `${delta > 0 ? "▲ +" : "▼ "}${delta.toFixed(2)}`;
    d.className = `trust-delta show ${delta > 0 ? "up" : "down"}`;
    const v = $("trustValue"); v.classList.remove("pulse"); void v.offsetWidth; v.classList.add("pulse");
  } else d.className = "trust-delta";
}

function renderMemory(mem, roundNo) {
  $("memoryHead").textContent = `What the Buyer remembered before deal ${roundNo}`;
  if (!mem || (!mem.opinion && !(mem.memories || []).length)) {
    $("memoryBody").innerHTML = `<div class="empty-state small">First contact — no memory yet. The Buyer negotiates blind.</div>`;
    return;
  }
  let html = "";
  if (mem.opinion) {
    const o = mem.opinion;
    html += `<div class="reflection"><span class="label">reflect() had concluded — trust ${o.trust.toFixed(2)}, confidence ${Math.round(o.confidence * 100)}%</span>${esc(o.reasoning || "")}</div>`;
  }
  if ((mem.memories || []).length) {
    html += `<span class="label" style="font-family:'IBM Plex Mono',monospace;font-size:.64rem;color:#4A5A4F">recall() returned</span>` +
      mem.memories.map((m) => `<div class="mem-item">${esc(m)}</div>`).join("");
  }
  $("memoryBody").innerHTML = html;
}

const cumulative = (arr) => arr.reduce((a, r) => (a.push((a.length ? a[a.length - 1] : 0) + (r ? r.outcome.netDamage : 0)), a), []);

function renderImpact() {
  const rs = S.rounds, cs = S.control;
  const el = $("impactBody");
  if (!rs.length) { el.innerHTML = `<div class="impact-note">Every day of delay costs the Buyer ${money(S.limits.lossPerLateDay)}. Damage from broken promises is tracked here.</div>`; return; }
  const mem = cumulative(rs);
  if (S.config.compare && cs.length) {
    const ctl = cumulative(cs);
    const m = mem[mem.length - 1], c = ctl[ctl.length - 1];
    const maxV = Math.max(1000, ...mem, ...ctl);
    const w = 240, h = 110, pad = 10, n = Math.max(mem.length, 2);
    const x = (i) => pad + (i * (w - pad * 2)) / (n - 1);
    const y = (v) => h - pad - (v / maxV) * (h - pad * 2);
    const line = (arr, col) => `<polyline points="${arr.map((v, i) => `${x(i)},${y(v)}`).join(" ")}" fill="none" stroke="${col}" stroke-width="2"/>` +
      arr.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="2.6" fill="${col}"/>`).join("");
    el.innerHTML = `<div class="impact-num">
        <div><div class="big good">${money(m)}</div><div class="cap">lost to delays — Buyer WITH memory</div></div>
        <div><div class="big badc">${money(c)}</div><div class="cap">lost — Buyer WITHOUT memory</div></div></div>
      <svg id="impactChart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${line(ctl, "#9A3324")}${line(mem, "#2F6B3E")}</svg>
      <div class="legend"><span><i style="background:#2F6B3E"></i>with memory</span><span><i style="background:#9A3324"></i>no memory</span></div>
      <div class="impact-note">${c > m ? `Memory has saved <b>${money(c - m)}</b> so far, facing the same seller and the same delivery luck.` : "So far memory hasn't saved money — keep running deals."}</div>`;
  } else {
    el.innerHTML = `<div class="impact-num"><div><div class="big ${mem[mem.length - 1] ? "badc" : "good"}">${money(mem[mem.length - 1])}</div><div class="cap">lost to late deliveries so far</div></div></div>
      <div class="impact-note">Tick “Compare with a Buyer that has no memory” to run the same seller against a Buyer that forgets everything — and see what memory is worth.</div>`;
  }
}

function renderBadges() {
  const ops = S.ops || [], m = S.mode;
  const memFb = ops.some((o) => o.mode === "live-fallback"), llmFb = ops.some((o) => o.mode === "llm-fallback");
  const mb = $("memBadge"), lb = $("llmBadge");
  if (m.memory === "live") {
    mb.textContent = memFb ? "memory · Hindsight live — fallback used" : "memory · Hindsight (live)";
    mb.className = "badge " + (memFb ? "bad" : "ok");
  } else { mb.textContent = "memory · local stand-in (demo)"; mb.className = "badge warn"; }
  if (m.llm.offline) {
    lb.textContent = "agents · offline rule-based — add an LLM key"; lb.className = "badge warn";
  } else {
    lb.textContent = llmFb ? "agents · LLM call failed — fallback used" : `agents · ${m.llm.provider} · ${m.llm.model}`;
    lb.className = "badge " + (llmFb ? "bad" : "ok");
  }
}

function renderOps() {
  const ops = S.ops || [];
  if (!ops.length) { $("opsFeed").innerHTML = `<div class="empty-state small">Nothing yet.</div>`; return; }
  $("opsFeed").innerHTML = ops.map((o) => {
    const t = new Date(o.ts).toLocaleTimeString([], { hour12: false });
    const base = o.op.split(":")[0];
    return `<div class="op-row"><span class="op-time">${t}</span><span class="op-name ${base}">${esc(o.op === "reflect:result" ? "reflect ⇒" : o.op)}</span><span class="op-text">${esc(o.summary)}</span></div>`;
  }).join("");
  $("opsFeed").scrollTop = $("opsFeed").scrollHeight;
}

function renderSide(animateDelta = null) {
  const series = S.rounds.map((r) => r.opinionAfter && r.opinionAfter.trust).filter((v) => typeof v === "number");
  renderTrust(S.opinion, series, animateDelta);
  renderImpact(); renderBadges(); renderOps(); renderChips();
}

function renderAll() {
  const sel = $("persona");
  if (!sel.options.length) sel.innerHTML = Object.entries(S.personas).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  sel.value = S.config.persona;
  $("compare").checked = S.config.compare;
  renderSide();
  if (S.rounds.length) { view = S.rounds.length - 1; showRecord(S.rounds[view]); renderChips(); } else { view = null; showEmptyRoom(); }
}

// ------------------------------------------------------------- live events
function handleEvent(e) {
  switch (e.type) {
    case "stage": setStatus(e.text); break;
    case "memory": renderMemory(e.memory, S.rounds.length + 1); break;
    case "typing": showTyping(e.who); break;
    case "message": removeTyping(); $("chat").insertAdjacentHTML("beforeend", msgHTML(e)); break;
    case "deal": removeTyping(); $("dealCard").hidden = false; $("dealCard").innerHTML = dealHTML(e.deal); break;
    case "outcome":
      $("deliveryCard").hidden = false; $("deliveryCard").innerHTML = deliveryHTML(e.outcome); animateDelivery(true);
      setStatus(e.outcome.kept ? "Delivered as promised." : "The Seller broke its promise.");
      break;
    case "opinion": {
      const prev = S.opinion && S.opinion.evidenceCount ? S.opinion.trust : 0.5;
      const series = S.rounds.map((r) => r.opinionAfter && r.opinionAfter.trust).filter((v) => typeof v === "number").concat(e.opinion.trust);
      pendingDelta = e.opinion.trust - prev;
      renderTrust(e.opinion, series, pendingDelta);
      break;
    }
    case "done":
      S = e.state; liveMode = false; view = S.rounds.length - 1; removeTyping();
      renderSide(pendingDelta); pendingDelta = null; setStatus(S.rounds[view].outcome.kept ? "Deal complete — delivered as promised." : "Deal complete — the Seller broke its promise.");
      break;
    case "error": lastFailed = true; removeTyping(); setStatus("Error: " + e.message, true); break;
  }
}

async function streamDeal() {
  const res = await fetch("/api/round", { method: "POST" });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) handleEvent(JSON.parse(line));
    }
  }
}

async function runOnce() {
  startLive();
  try { await streamDeal(); }
  catch (err) { lastFailed = true; liveMode = false; removeTyping(); setStatus("Something went wrong: " + err.message, true); renderChips(); }
  return !lastFailed;
}

function setBusy(b, auto = false) {
  ["runRound", "runFive", "persona", "compare", "resetBtn"].forEach((id) => ($(id).disabled = b));
  $("stopBtn").hidden = !(b && auto);
  $("stopBtn").textContent = "Stop after this deal";
}

async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

// ------------------------------------------------------------------ wiring
$("runRound").onclick = async () => { setBusy(true); await runOnce(); setBusy(false); };
$("runFive").onclick = async () => {
  stopAfter = false; setBusy(true, true);
  for (let i = 0; i < 5 && !stopAfter; i++) { if (!(await runOnce())) break; await sleep(1800); }
  setBusy(false);
};
$("stopBtn").onclick = () => { stopAfter = true; $("stopBtn").textContent = "Stopping…"; };
$("resetBtn").onclick = async () => { S = await api("/api/reset"); renderAll(); };
$("persona").onchange = async () => { S = await api("/api/config", { persona: $("persona").value, compare: $("compare").checked }); renderAll(); };
$("compare").onchange = async () => { S = await api("/api/config", { persona: $("persona").value, compare: $("compare").checked, keepSeed: true }); renderAll(); };
$("roundChips").onclick = (ev) => {
  const b = ev.target.closest(".chip[data-i]");
  if (!b || liveMode) return;
  view = +b.dataset.i; showRecord(S.rounds[view]); renderChips();
};

(async () => { S = await (await fetch("/api/state")).json(); renderAll(); })();

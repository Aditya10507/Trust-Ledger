const express = require("express");
const fs = require("fs");
const path = require("path");
const game = require("./game");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const clearDemoStore = () => {
  const p = path.join(__dirname, "..", "data", "memory-store.json");
  if (fs.existsSync(p)) fs.unlinkSync(p);
};

app.get("/api/state", (req, res) => res.json(game.getState()));

app.post("/api/config", (req, res) => {
  if (game.isBusy()) return res.status(409).json({ error: "A deal is in progress" });
  clearDemoStore();
  game.configure({ persona: req.body.persona, compare: req.body.compare, keepSeed: req.body.keepSeed });
  res.json(game.getState());
});

app.post("/api/reset", (req, res) => {
  if (game.isBusy()) return res.status(409).json({ error: "A deal is in progress" });
  clearDemoStore();
  game.reset();
  res.json(game.getState());
});

// Streams newline-delimited JSON events while the deal unfolds.
app.post("/api/round", async (req, res) => {
  if (game.isBusy()) return res.status(409).json({ error: "A deal is already in progress" });
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const emit = (evt) => res.write(JSON.stringify(evt) + "\n");
  try {
    await game.playNext(emit);
  } catch (err) {
    console.error(err);
    emit({ type: "error", message: err.message });
  }
  res.end();
});

app.listen(PORT, () => {
  const s = game.getState().mode;
  console.log(`Trust Ledger → http://localhost:${PORT}`);
  console.log(`  memory: ${s.memory}   agents: ${s.llm.offline ? "OFFLINE rule-based (no LLM key)" : `${s.llm.provider} / ${s.llm.model}`}`);
});

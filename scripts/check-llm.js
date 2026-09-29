/**
 * check-llm.js — run this BEFORE your demo to confirm the agents' LLM works.
 *   export OPENAI_API_KEY=sk-...        (or ANTHROPIC_API_KEY, or LLM_API_KEY + LLM_BASE_URL)
 *   npm run check-llm
 */
const llm = require("../src/llm");

(async () => {
  if (llm.info.offline) {
    console.log("No LLM key found — the app would use offline rule-based agents.");
    console.log("Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or LLM_API_KEY (+ LLM_BASE_URL), then run again.");
    process.exit(1);
  }
  console.log(`Testing ${llm.info.provider} / ${llm.info.model} ...`);
  const t0 = Date.now();
  try {
    const raw = await llm.complete({
      system: 'Reply with ONLY a JSON object: {"ok": true, "message": "<one short friendly sentence>"}',
      user: "Say hello.",
      maxTokens: 200,
    });
    const j = llm.parseJSON(raw);
    console.log(`✅ LLM OK (${((Date.now() - t0) / 1000).toFixed(1)}s): ${j.message}`);
  } catch (err) {
    console.error("❌ LLM call failed:", err.message);
    console.error("Check the key, the model name (set LLM_MODEL to a current model), and LLM_BASE_URL if you use a non-OpenAI provider.");
    process.exit(1);
  }
})();

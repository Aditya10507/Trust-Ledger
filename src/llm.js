/**
 * llm.js — one tiny interface over whichever LLM you have a key for.
 *
 *   OpenAI or any OpenAI-compatible API (Groq, Gemini's compat endpoint,
 *   Ollama, ...):  LLM_API_KEY (or OPENAI_API_KEY), optional LLM_BASE_URL,
 *                  optional LLM_MODEL
 *   Anthropic:     ANTHROPIC_API_KEY, optional LLM_MODEL
 *   No key:        provider = "offline" (rule-based agents, for rehearsal)
 */
function detectProvider() {
  const p = (process.env.LLM_PROVIDER || "").toLowerCase();
  if (p) return p;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY) return "openai";
  return "offline";
}

const provider = detectProvider();
const cfg = {
  openai: {
    baseUrl: (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    key: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
    model: process.env.LLM_MODEL || "gpt-4o-mini",
  },
  anthropic: {
    baseUrl: (process.env.LLM_BASE_URL || "https://api.anthropic.com").replace(/\/$/, ""),
    key: process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY,
    model: process.env.LLM_MODEL || "claude-haiku-4-5-20251001",
  },
}[provider];

const info = {
  provider,
  model: cfg ? cfg.model : null,
  offline: provider === "offline",
};

async function post(url, headers, body, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAI({ system, user, maxTokens, temperature }) {
  const body = {
    model: cfg.model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_tokens: maxTokens,
    temperature,
  };
  // Newer models reject max_tokens / temperature — adapt on a 400 and retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await post(`${cfg.baseUrl}/chat/completions`, { Authorization: `Bearer ${cfg.key}` }, body);
    if (r.ok) {
      const data = JSON.parse(r.text);
      return data.choices?.[0]?.message?.content || "";
    }
    if (r.status === 400 && /max_completion_tokens/i.test(r.text) && body.max_tokens) {
      body.max_completion_tokens = body.max_tokens; delete body.max_tokens; continue;
    }
    if (r.status === 400 && /temperature/i.test(r.text) && "temperature" in body) {
      delete body.temperature; continue;
    }
    throw new Error(`LLM ${r.status}: ${r.text.slice(0, 200)}`);
  }
  throw new Error("LLM request rejected after adjustments");
}

async function callAnthropic({ system, user, maxTokens, temperature }) {
  const r = await post(
    `${cfg.baseUrl}/v1/messages`,
    { "x-api-key": cfg.key, "anthropic-version": "2023-06-01" },
    { model: cfg.model, max_tokens: maxTokens, temperature, system, messages: [{ role: "user", content: user }] }
  );
  if (!r.ok) throw new Error(`LLM ${r.status}: ${r.text.slice(0, 200)}`);
  const data = JSON.parse(r.text);
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function complete({ system, user, maxTokens = 400, temperature = 0.7 }) {
  if (info.offline) throw new Error("no LLM configured");
  if (!cfg.key) throw new Error("LLM API key missing");
  const fn = provider === "anthropic" ? callAnthropic : callOpenAI;
  try {
    return await fn({ system, user, maxTokens, temperature });
  } catch (err) {
    // one retry for transient failures (network, 429, 5xx)
    if (/fetch failed|aborted|LLM (429|5\d\d)/i.test(err.message)) {
      await new Promise((r) => setTimeout(r, 1500));
      return fn({ system, user, maxTokens, temperature });
    }
    throw err;
  }
}

// Pull a JSON object out of a model reply (tolerates code fences / chatter).
function parseJSON(text) {
  const cleaned = String(text).replace(/```json|```/gi, "");
  const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in reply");
  return JSON.parse(cleaned.slice(a, b + 1));
}

module.exports = { complete, parseJSON, info };

/**
 * check-hindsight.js
 * ------------------------------------------------------------------
 * Run this BEFORE your demo (not during it) to confirm real Hindsight
 * is actually reachable and returning the shape this app expects.
 *
 * Usage:
 *   export HINDSIGHT_MODE=live
 *   export HINDSIGHT_API_URL=http://localhost:8888
 *   node scripts/check-hindsight.js
 *
 * This bypasses the demo-mode fallback on purpose — if it fails here,
 * you want to see the real error now, not silently fall back later.
 * ------------------------------------------------------------------
 */

async function main() {
  if (process.env.HINDSIGHT_MODE !== "live") {
    console.log("HINDSIGHT_MODE is not 'live' — set it before running this check:");
    console.log("  export HINDSIGHT_MODE=live");
    console.log("  export HINDSIGHT_API_URL=http://localhost:8888");
    process.exit(1);
  }

  let HindsightClient;
  try {
    ({ HindsightClient } = require("@vectorize-io/hindsight-client"));
  } catch (e) {
    console.error("❌ @vectorize-io/hindsight-client is not installed.");
    console.error("   Run: npm install @vectorize-io/hindsight-client");
    process.exit(1);
  }

  const baseUrl = process.env.HINDSIGHT_API_URL || "http://localhost:8888";
  const client = new HindsightClient({ baseUrl });
  const bankId = "trust-ledger-selfcheck";

  console.log(`Checking Hindsight at ${baseUrl} ...`);

  try {
    console.log("→ retain()...");
    await client.retain(bankId, "Self-check: seller kept a delivery promise.", {
      metadata: { round: 1, kept: true },
    });
    console.log("  ✅ retain OK");

    console.log("→ recall()...");
    const recallResult = await client.recall(bankId, "What has this seller done?");
    console.log(`  ✅ recall OK — ${(recallResult.results || []).length} memory(ies) found`);

    console.log("→ reflect() with response_schema...");
    const schema = {
      type: "object",
      properties: {
        trust: { type: "number" },
        confidence: { type: "number" },
        evidenceCount: { type: "integer" },
        reasoning: { type: "string" },
      },
      required: ["trust", "confidence", "evidenceCount"],
    };
    const reflectResult = await client.reflect(
      bankId,
      "What trust score (0-1) should this seller have right now, and why?",
      { responseSchema: schema, budget: "low" }
    );

    if (!reflectResult.structured_output) {
      console.warn("  ⚠️  reflect() succeeded but structured_output is empty.");
      console.warn("     Raw response:", JSON.stringify(reflectResult, null, 2));
      console.warn("     You may need to adjust the schema or check the Hindsight version.");
    } else {
      console.log("  ✅ reflect OK — structured_output:", reflectResult.structured_output);
    }

    console.log("\nAll checks passed. You're good to switch the app to HINDSIGHT_MODE=live.");
  } catch (err) {
    console.error("\n❌ A live call failed:", err.message);
    console.error("Common causes: Hindsight container not running, wrong HINDSIGHT_API_URL,");
    console.error("or the LLM API key Hindsight was started with is missing/invalid.");
    process.exit(1);
  }
}

main();

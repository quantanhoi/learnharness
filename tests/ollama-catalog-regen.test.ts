import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog, contextFromShow, displayNames, parsePricing } from "../scripts/regen-ollama-catalog.mjs";

/**
 * The Ollama Cloud catalog's regeneration logic (owner ruling, 2026-10-27:
 * the curated table stays honest via a script, not by hand). Pure parsing +
 * joining over FIXTURES — the network fetches happen only in the script's
 * CLI main; tests stay offline (the deterministic-suite law).
 *
 * Sources at generation time: model names + capabilities from
 * ollama.com/api/tags (JSON, no auth), prices from the /pricing page's HTML
 * table, EXACT context lengths from POST /api/show's model_info (needs the
 * OLLAMA_API_KEY — the HTML pages lie: blurbs say "1M context window" over a
 * 512K model). The script rewrites the marked region of
 * src/agent/ollama-cloud.ts; the human reviews the git diff and commits.
 */

const PRICING_HTML = `<table>
<tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr>
<tr><td><a href="/library/deepseek-v4.1-flash">deepseek-v4.1-flash</a></td><td>$0.30</td><td>$0.006</td><td>$1.20</td></tr>
<tr><td><a href="/library/deepseek-v4.1-flash">deepseek-v4.1-flash (Off-Peak)</a></td><td>$0.15</td><td>$0.003</td><td>$0.60</td></tr>
<tr><td><a href="/library/gpt-oss">gpt-oss:20b</a></td><td>$0.07</td><td>$0.035</td><td>$0.30</td></tr>
<tr><td><a href="/library/mistral-large-3">mistral-large-3</a></td><td>$0.50</td><td>-</td><td>$1.50</td></tr>
</table>`;

const TAGS = {
	models: [
		{ name: "deepseek-v4.1-flash", capabilities: ["completion", "thinking", "tools", "vision"] },
		{ name: "deepseek-v4.1-flash:1017", capabilities: ["completion", "thinking", "tools", "vision"] },
		{ name: "gpt-oss:20b", capabilities: ["completion", "thinking", "tools"] },
		{ name: "clef:27b", capabilities: ["decision", "vision"] },
		{ name: "brand-new", capabilities: ["completion", "thinking"] },
	],
};

describe("parsePricing — the /pricing table", () => {
	it("maps model rows to USD numbers, skips Off-Peak, dash = no cached rate", () => {
		const pricing = parsePricing(PRICING_HTML);
		assert.deepEqual(pricing.get("deepseek-v4.1-flash"), { input: 0.3, cached: 0.006, output: 1.2 });
		assert.deepEqual(pricing.get("gpt-oss:20b"), { input: 0.07, cached: 0.035, output: 0.3 });
		// A dash in Cached input means no published rate (null → the catalog
		// convention: cacheRead carries the INPUT rate, never under-report).
		assert.deepEqual(pricing.get("mistral-large-3"), { input: 0.5, cached: null, output: 1.5 });
		assert.equal(pricing.size, 3, "Off-Peak row skipped");
	});
});

describe("contextFromShow — POST /api/show's model_info", () => {
	it("reads the EXACT context length (the HTML pages lie; this cannot)", () => {
		// Real values captured 2026-10-27: minimax-m3's blurb says "1M context
		// window" while the model serves 512000; gemma4:31b is 262144 (the
		// true 256K), not the rounded 256000.
		assert.equal(contextFromShow({ model_info: { "minimax-m3.context_length": 512000 } }), 512000);
		assert.equal(contextFromShow({ model_info: { "gemma4.context_length": 262144 } }), 262144);
		assert.equal(contextFromShow({ model_info: { "beam.attention.head_count": 42 } }), undefined);
		assert.equal(contextFromShow({}), undefined);
	});
});

describe("displayNames — the curated human labels", () => {
	it("covers every current model; unknown ids fall back to the raw id", () => {
		assert.equal(displayNames["deepseek-v4.1-flash:1017"], "DeepSeek V4.1 Flash (1017)");
		assert.equal(displayNames["glm-5.3"], "GLM-5.3");
		assert.equal(displayNames["gemma4:31b"], "Gemma 4 31B");
		// A NEW model's label is its id until a human adds it — the regen
		// report names the models that need one.
		assert.equal(displayNames["brand-new"], undefined);
	});
});

describe("buildCatalog — names ∪ prices ∪ contexts", () => {
	it("excludes non-chat models, joins by exact id then family, flags gaps", () => {
		const pricing = parsePricing(PRICING_HTML);
		const contexts = new Map([["deepseek-v4.1-flash", 1_000_000], ["gpt-oss", 131_072]]);
		const { rows, report } = buildCatalog(TAGS as never, pricing, contexts);
		const ids = rows.map((r) => r.id);
		assert.ok(!ids.includes("clef:27b"), "decision models are not chat models");
		// Rows sort alphabetically by id — stable, diff-friendly.
		assert.deepEqual(ids, ["brand-new", "deepseek-v4.1-flash", "deepseek-v4.1-flash:1017", "gpt-oss:20b"]);
		// The tagged variant joins its family's price AND context.
		const variant = rows.find((r) => r.id === "deepseek-v4.1-flash:1017");
		assert.deepEqual(variant, {
			id: "deepseek-v4.1-flash:1017",
			name: "DeepSeek V4.1 Flash (1017)",
			price: { input: 0.3, cached: 0.006, output: 1.2 },
			contextWindow: 1_000_000,
			vision: true,
			thinking: true,
		});
		// A model with no sources gets conservative defaults and is flagged.
		const fresh = rows.find((r) => r.id === "brand-new");
		assert.deepEqual(fresh!.price, { input: 0, cached: null, output: 0 });
		assert.equal(fresh!.contextWindow, 4096);
		assert.deepEqual(report.missingPrice, ["brand-new"]);
		assert.deepEqual(report.missingContext, ["brand-new"]);
		// No price change on known rows → the drift report is empty.
		assert.deepEqual(report.changedPrice, []);
	});
});
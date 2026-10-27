import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { OLLAMA_CLOUD_MODELS, ollamaCloudProvider } from "../src/agent/ollama-cloud.ts";
import { piModels } from "../src/agent/models.ts";
import { AUTH_PROVIDER_KEYS, isProviderEnvVar } from "../src/core/auth-keys.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

/**
 * The Ollama Cloud provider (owner redirect, 2026-10-27): ollama.com's keyed
 * hosted service — a NORMAL keyed provider (unlike the scrapped local
 * auto-probe design). The catalog is hand-curated (owner choice over a
 * dynamic /api/tags fetch: the tags endpoint returns names only — no price,
 * no context — and the app's cost + context meters read both). Curated from
 * ollama.com/pricing, the library pages, and /api/tags on 2026-10-27.
 */

const savedKey = process.env.OLLAMA_API_KEY;
after(() => {
	if (savedKey === undefined) delete process.env.OLLAMA_API_KEY;
	else process.env.OLLAMA_API_KEY = savedKey;
});

describe("the ollama cloud catalog", () => {
	it("carries every entry with price, context, and the compat API shape", () => {
		assert.ok(OLLAMA_CLOUD_MODELS.length >= 20, `a real cloud catalog, got ${OLLAMA_CLOUD_MODELS.length}`);
		for (const model of OLLAMA_CLOUD_MODELS) {
			assert.equal(model.provider, "ollama-cloud");
			assert.equal(model.api, "openai-completions");
			assert.equal(model.baseUrl, "https://ollama.com/v1");
			assert.ok(model.contextWindow > 0, `${model.id} context`);
			assert.ok(model.maxTokens > 0, `${model.id} maxTokens`);
			assert.ok(model.cost.input >= 0 && model.cost.output >= 0, `${model.id} cost`);
			for (const modality of model.input) assert.ok(["text", "image"].includes(modality), `${model.id} input`);
		}
	});

	it("pins a curated specimen (gemma4:31b from ollama.com/pricing)", () => {
		const gemma = OLLAMA_CLOUD_MODELS.find((m) => m.id === "gemma4:31b");
		assert.ok(gemma, "gemma4:31b present (the /api/tags API name, not the bare library name)");
		assert.deepEqual(gemma!.cost, { input: 0.14, output: 0.40, cacheRead: 0.05, cacheWrite: 0 });
		assert.equal(gemma!.contextWindow, 256_000);
		assert.deepEqual(gemma!.input, ["text", "image"]);
	});

	it("prices the free starter model at zero", () => {
		const beam = OLLAMA_CLOUD_MODELS.find((m) => m.id === "beam");
		assert.ok(beam, "beam present");
		assert.deepEqual(beam!.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("excludes the decision-only model (not a chat model)", () => {
		assert.ok(!OLLAMA_CLOUD_MODELS.some((m) => m.id.startsWith("clef")), "clef is a decision model, not chat");
	});

	it("is registered and served by the process-wide collection", () => {
		assert.ok(piModels().getProviders().some((p) => p.id === "ollama-cloud"));
		assert.equal(ollamaCloudProvider().id, "ollama-cloud");
		const served = piModels().getModels("ollama-cloud");
		assert.equal(served.length, OLLAMA_CLOUD_MODELS.length);
		for (const model of OLLAMA_CLOUD_MODELS) {
			assert.ok(served.some((m) => m.id === model.id), `${model.id} served`);
		}
	});

	it("resolves auth from OLLAMA_API_KEY (the keys seam's env var)", async () => {
		delete process.env.OLLAMA_API_KEY;
		assert.equal(await piModels().getAuth("ollama-cloud"), undefined, "no key → not configured");
		process.env.OLLAMA_API_KEY = "test-ollama-key";
		const auth = await piModels().getAuth("ollama-cloud");
		assert.equal(auth?.auth.apiKey, "test-ollama-key");
		assert.equal(auth?.source, "OLLAMA_API_KEY");
	});

	it("thinking-capable models carry ollama's full effort ladder (live-verified 2026-10-27)", () => {
		// Live probe: ollama.com's /v1/chat/completions accepts reasoning_effort
		// and validates it — a bogus value 400s listing the legal set
		// minimal|low|medium|high|xhigh|ultra|max|none; gpt-oss:20b's own
		// reasoning grew 17→143 chars from low→high, so the levels are real.
		const gpt = OLLAMA_CLOUD_MODELS.find((m) => m.id === "gpt-oss:20b");
		assert.ok(gpt, "gpt-oss:20b present");
		assert.equal(gpt!.reasoning, true);
		assert.deepEqual(getSupportedThinkingLevels(gpt!), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		// Map values are ollama's own accepted strings, 1:1 with pi's ladder.
		assert.deepEqual(gpt!.thinkingLevelMap, {
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("the non-thinking model stays off-only", () => {
		const mistral = OLLAMA_CLOUD_MODELS.find((m) => m.id === "mistral-large-3:675b");
		assert.ok(mistral, "mistral-large-3:675b present");
		assert.equal(mistral!.reasoning, false);
		assert.deepEqual(getSupportedThinkingLevels(mistral!), ["off"]);
	});
});

describe("the provider-key table row", () => {
	it("rides AUTH_PROVIDER_KEYS (settings dropdown, writability, turn gate)", () => {
		const row = AUTH_PROVIDER_KEYS.find((p) => p.id === "ollama-cloud");
		assert.deepEqual(row, { id: "ollama-cloud", envVar: "OLLAMA_API_KEY", label: "Ollama Cloud" });
		assert.ok(isProviderEnvVar("OLLAMA_API_KEY"));
	});
});
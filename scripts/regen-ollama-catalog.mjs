#!/usr/bin/env node
/**
 * regen-ollama-catalog.mjs — regenerate the OLLAMA_CLOUD_MODELS table in
 * src/agent/ollama-cloud.ts from ollama.com's own surfaces (owner ruling,
 * 2026-10-27: the curated catalog stays honest via a script, not by hand):
 *
 *   names + capabilities  GET https://ollama.com/api/tags      (JSON, no auth)
 *   prices                GET https://ollama.com/pricing       (HTML table)
 *   contexts              GET https://ollama.com/library/<family>  (per model)
 *
 * Everything between the BEGIN/END ollama-catalog markers in the provider is
 * REPLACED; the human reviews `git diff src/agent/ollama-cloud.ts` and
 * commits. Never a silent write: gaps are flagged in the report —
 *   missingPrice    no /pricing row (free, new, or the page moved) → zeros
 *   missingContext  no context figure on the library page → 4096
 *   added/removed   churn vs the table currently in the file
 *   changedPrice    drift vs the table currently in the file
 * Models without the "completion" capability (clef is a decision model) are
 * not chat models and never enter the catalog. The pure parsing/joining
 * exports are pinned offline by tests/ollama-catalog-regen.test.ts.
 *
 * Usage: node scripts/regen-ollama-catalog.mjs [--key <OLLAMA_API_KEY>]
 */

import { readFileSync, writeFileSync } from "node:fs";

const PROVIDER = "src/agent/ollama-cloud.ts";
const TAGS_URL = "https://ollama.com/api/tags";
const PRICING_URL = "https://ollama.com/pricing";
const SHOW_URL = "https://ollama.com/api/show";

/** Curated human display labels (the picker menu shows Model.name). A new
 *  model falls back to its raw id until a human adds one — the regen report
 *  names the models that need it.
 *  @type {Record<string, string>} */
export const displayNames = {
	"deepseek-v4.1-flash:1017": "DeepSeek V4.1 Flash (1017)",
	beam: "Beam",
	"deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
	"deepseek-v4-pro:0813": "DeepSeek V4 Pro",
	"gemma4:31b": "Gemma 4 31B",
	"glm-5.2": "GLM-5.2",
	"glm-5.3": "GLM-5.3",
	"glm-5.3-flash": "GLM-5.3 Flash",
	"gpt-oss:20b": "GPT-OSS 20B",
	"gpt-oss:120b": "GPT-OSS 120B",
	"kimi-k2.6": "Kimi K2.6",
	"kimi-k2.7-code": "Kimi K2.7 Code",
	"kimi-k3": "Kimi K3",
	"minimax-m2.7": "MiniMax M2.7",
	"minimax-m3": "MiniMax M3",
	"minimax-m3.1-flash": "MiniMax M3.1 Flash",
	"mistral-large-3:675b": "Mistral Large 3",
	"mistral-large-4": "Mistral Large 4",
	"muse-spark-open": "Muse Spark Open",
	"nemotron-3-nano:30b": "Nemotron 3 Nano 30B",
	"nemotron-3-super": "Nemotron 3 Super",
	"nemotron-3-ultra": "Nemotron 3 Ultra",
};

const NO_PRICE = Object.freeze({ input: 0, cached: null, output: 0 });
const DEFAULT_CONTEXT = 4096;

/** The /pricing table: model name → USD per 1M tokens. A dash in Cached
 *  input means no published rate (null). "(Off-Peak)" rows are skipped —
 *  the catalog carries peak prices (conservative: never under-report). */
export function parsePricing(html) {
	const table = html.match(/<table[^>]*>([\s\S]*?)<\/table>/)?.[1] ?? "";
	const pricing = new Map();
	for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
		const cells = [...row[1].matchAll(/<t[d][^>]*>([\s\S]*?)<\/t[d]>/g)].map((c) =>
			c[1].replace(/<[^>]+>/g, "").trim(),
		);
		if (cells.length < 4) continue;
		const name = cells[0];
		if (!name || /\(Off-Peak\)/i.test(name)) continue;
		const money = (cell) => {
			const m = cell.match(/\$([0-9.]+)/);
			return m ? Number(m[1]) : null;
		};
		const input = money(cells[1]);
		if (input === null) continue; // header or non-price row
		pricing.set(name.replace(/\s*\(.*\)\s*$/, "").trim(), { input, cached: money(cells[2]), output: money(cells[3]) });
	}
	return pricing;
}

/** POST /api/show's model_info → the model's EXACT context length. The
 *  HTML sources lie for this (blurbs say "1M context window" over a 512K
 *  model; per-size tag rows show smaller variants); the API cannot. */
export function contextFromShow(showJson) {
	const info = showJson?.model_info ?? {};
	for (const [key, value] of Object.entries(info)) {
		if (key.endsWith(".context_length") && typeof value === "number") return value;
	}
	return undefined;
}

const baseOf = (id) => (id.includes(":") ? id.slice(0, id.indexOf(":")) : id);

/** Names ∪ prices ∪ contexts → catalog rows + an honest gap report. */
export function buildCatalog(tags, pricing, contexts, previous = []) {
	const before = new Map(previous.map((row) => [row.id, row.price]));
	const rows = [];
	const report = { added: [], removed: [], changedPrice: [], missingPrice: [], missingContext: [], needsDisplayName: [] };
	for (const model of tags.models ?? []) {
		const capabilities = model.capabilities ?? [];
		if (!capabilities.includes("completion")) continue; // decision models are not chat models
		const id = model.name;
		const price = pricing.get(id) ?? pricing.get(baseOf(id));
		const contextWindow = contexts.get(id) ?? contexts.get(baseOf(id)) ?? DEFAULT_CONTEXT;
		if (!price) report.missingPrice.push(id);
		if (!contexts.has(id) && !contexts.has(baseOf(id))) report.missingContext.push(id);
		if (!displayNames[id]) report.needsDisplayName.push(id);
		const prior = before.get(id);
		if (prior === undefined) report.added.push(id);
		else if (JSON.stringify(prior) !== JSON.stringify(price ?? NO_PRICE)) report.changedPrice.push(id);
		before.delete(id);
		rows.push({
			id,
			name: displayNames[id] ?? id,
			price: price ?? NO_PRICE,
			contextWindow,
			vision: capabilities.includes("vision"),
			thinking: capabilities.includes("thinking"),
		});
	}
	report.removed = [...before.keys()];
	rows.sort((a, b) => a.id.localeCompare(b.id));
	return { rows, report };
}

/** Reproduce the pricing page's decimal form: 0.3 → "0.30", 0.006 → "0.006",
 *  0.015 → "0.015" (toFixed(2) lies for it), 3 → "3.00". */
function money(n) {
	if (n === null) return "null";
	for (const digits of [2, 3]) {
		const s = n.toFixed(digits);
		if (Number(s) === n) return s;
	}
	return String(n);
}

function renderRows(rows) {
	return rows
		.map(
			(r) =>
				`\tcloudModel(${JSON.stringify(r.id)}, ${JSON.stringify(r.name)}, { input: ${money(r.price.input)}, cached: ${money(r.price.cached)}, output: ${money(r.price.output)} }, ${r.contextWindow.toLocaleString("en-US").replace(/,/g, "_")}, ${r.vision}, ${r.thinking}),`,
		)
		.join("\n");
}

/** The table currently in the provider file — for added/removed/price
 *  drift. Parsed from the generated region, never trusted blindly. */
function currentRows(source) {
	const rows = [];
	const region = source.match(/BEGIN ollama-catalog[\s\S]*END ollama-catalog/)?.[0] ?? "";
	for (const line of region.matchAll(/cloudModel\("([^"]+)", "[^"]*", \{ input: ([0-9.]+), cached: (null|[0-9.]+), output: ([0-9.]+) \}/g)) {
		rows.push({ id: line[1], price: { input: Number(line[2]), cached: line[3] === "null" ? null : Number(line[3]), output: Number(line[4]) } });
	}
	return rows;
}

async function fetchText(url, init) {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} → HTTP ${response.status}`);
	return response.text();
}

/** The API key for /api/show: --key flag, else OLLAMA_API_KEY, else the
 *  running app's own store (this is a maintainer tool on the app's machine). */
function apiKey(argv) {
	const flag = argv.indexOf("--key");
	if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
	if (process.env.OLLAMA_API_KEY) return process.env.OLLAMA_API_KEY;
	for (const store of ["~/.config/LearnHarness/auth.json"]) {
		try {
			const path = store.replace("~", process.env.HOME ?? "");
			const auth = JSON.parse(readFileSync(path, "utf8"));
			if (auth.OLLAMA_API_KEY) return auth.OLLAMA_API_KEY;
		} catch {
			// No store at this path — try the next source.
		}
	}
	return undefined;
}

function printReport(report, rows) {
	const list = (label, ids) => ids.length && console.log(`  ${label}: ${ids.join(", ")}`);
	console.log(`[regen-ollama-catalog] ${rows.length} models written`);
	list("ADDED", report.added);
	list("REMOVED", report.removed);
	list("CHANGED PRICE", report.changedPrice);
	list("missing price (zeros written)", report.missingPrice);
	list("missing context (4096 written)", report.missingContext);
	list("needs a display name (raw id used)", report.needsDisplayName);
	console.log("[regen-ollama-catalog] review with: git diff src/agent/ollama-cloud.ts");
}

async function main() {
	const key = apiKey(process.argv);
	if (!key) throw new Error("no API key — pass --key, export OLLAMA_API_KEY, or save it in the app (Keys → Ollama Cloud)");
	const [tagsRaw, pricingHtml] = await Promise.all([fetchText(TAGS_URL), fetchText(PRICING_URL)]);
	const tags = JSON.parse(tagsRaw);
	const pricing = parsePricing(pricingHtml);
	const contexts = new Map();
	const chat = (tags.models ?? []).filter((m) => (m.capabilities ?? []).includes("completion"));
	for (const model of chat) {
		// /api/show throttles bursts — a swallow-on-first-failure lost four
		// real contexts on the first run. Retry with backoff, then fall
		// through as missing (the report says so, loudly).
		for (let attempt = 0; ; attempt++) {
			try {
				const show = JSON.parse(
					await fetchText(SHOW_URL, {
						method: "POST",
						headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
						body: JSON.stringify({ model: model.name }),
					}),
				);
				const context = contextFromShow(show);
				if (context !== undefined) contexts.set(model.name, context);
				break;
			} catch (error) {
				if (attempt >= 2) {
					console.error(`[regen-ollama-catalog] /api/show failed for ${model.name}: ${error.message}`);
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
			}
		}
	}
	const source = readFileSync(PROVIDER, "utf8");
	const { rows, report } = buildCatalog(tags, pricing, contexts, currentRows(source));
	const block = source.match(/([\s\S]*BEGIN ollama-catalog[^\n]*\n)([\s\S]*?)(\/\/ END ollama-catalog)/);
	if (!block) throw new Error(`generated-region markers not found in ${PROVIDER}`);
	const generated = `${block[1]}export const OLLAMA_CLOUD_MODELS: readonly Model<"openai-completions">[] = [\n${renderRows(rows)}\n];\n${block[3]}`;
	writeFileSync(PROVIDER, source.replace(block[0], generated));
	printReport(report, rows);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(`[regen-ollama-catalog] FAILED, nothing written: ${error.message}`);
		process.exit(1);
	});
}
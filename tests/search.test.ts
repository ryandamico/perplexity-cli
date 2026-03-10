import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  buildRequestBody,
  parseResponse,
  formatMarkdown,
  formatJson,
  loadEnv,
  extractSearchQueries,
  extractUsageMetrics,
  getCostLimit,
  estimateCost,
} from "../search.ts";
import type { ParsedResponse, RequestMetadata } from "../search.ts";
import type { ResponseCreateResponse, ResponseCreateParams } from "@perplexity-ai/perplexity_ai/resources/responses";

const __dirname = typeof import.meta.dirname === "string"
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): ResponseCreateResponse {
  const raw = JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf-8"));
  // Simulate what the SDK's addOutputText does: concatenate all output_text blocks.
  // Real SDK responses always have output_text set; raw JSON fixtures don't.
  if (typeof raw.output_text !== "string") {
    const texts: string[] = [];
    for (const item of raw.output ?? []) {
      if (item.type === "message") {
        for (const block of item.content ?? []) {
          if (block.type === "output_text") {
            texts.push(block.text);
          }
        }
      }
    }
    raw.output_text = texts.join("");
  }
  return raw;
}

// ── parseArgs ──────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("zero args returns help flag", () => {
    const result = parseArgs([]);
    assert.equal(result.help, true);
  });

  it("convenience flags parsed correctly", () => {
    const result = parseArgs([
      "my query",
      "--preset", "deep-research",
      "--recency", "week",
      "--instructions", "be concise",
    ]);
    assert.equal(result.help, false);
    assert.equal(result.query, "my query");
    assert.equal(result.preset, "deep-research");
    assert.equal(result.recency, "week");
    assert.equal(result.instructions, "be concise");
    assert.equal(result.json, false);
    assert.equal(result.raw, false);
  });

  it("--body flag captures JSON string", () => {
    const body = '{"preset":"pro-search","input":"test"}';
    const result = parseArgs(["--body", body]);
    assert.equal(result.body, body);
    assert.equal(result.query, undefined);
  });

  it("--json and --raw flags work", () => {
    const result = parseArgs(["query", "--json"]);
    assert.equal(result.json, true);

    const result2 = parseArgs(["query", "--raw"]);
    assert.equal(result2.raw, true);
  });

  it("--domains flag parses comma-separated list", () => {
    const result = parseArgs(["query", "--domains", "arxiv.org,github.com"]);
    assert.deepEqual(result.domains, ["arxiv.org", "github.com"]);
  });

  it("--preset sets preset value", () => {
    const result = parseArgs(["query", "--preset", "fast-search"]);
    assert.equal(result.preset, "fast-search");
  });

  it("--preset accepts all preset names", () => {
    for (const name of ["fast-search", "pro-search", "deep-research", "advanced-deep-research"]) {
      const result = parseArgs(["query", "--preset", name]);
      assert.equal(result.preset, name);
    }
  });

  it("throws on unrecognized flags", () => {
    assert.throws(() => parseArgs(["query", "--receny", "week"]), /Unknown flag: --receny/);
    assert.throws(() => parseArgs(["query", "--fast"]), /Unknown flag: --fast/);
    assert.throws(() => parseArgs(["query", "--deep"]), /Unknown flag: --deep/);
  });

  it("throws when value-taking flag is missing its value", () => {
    assert.throws(() => parseArgs(["query", "--preset"]), /--preset requires a value/);
    assert.throws(() => parseArgs(["query", "--recency"]), /--recency requires a value/);
    assert.throws(() => parseArgs(["query", "--domains"]), /--domains requires a value/);
    assert.throws(() => parseArgs(["query", "--body"]), /--body requires a value/);
    assert.throws(() => parseArgs(["query", "--save"]), /--save requires a value/);
    assert.throws(() => parseArgs(["query", "--instructions"]), /--instructions requires a value/);
  });

  it("throws on multiple positional query arguments", () => {
    assert.throws(() => parseArgs(["query one", "query two"]), /Multiple query arguments/);
  });
});

// ── buildRequestBody ───────────────────────────────────────────────

describe("buildRequestBody", () => {
  it("convenience flags produce correct JSON", () => {
    const args = parseArgs(["my query", "--preset", "pro-search"]);
    const body = buildRequestBody(args);
    assert.equal(body.input, "my query");
    assert.equal(body.preset, "pro-search");
    assert.equal(body.stream, false);
  });

  it("--body passthrough preserves user JSON", () => {
    const userBody = '{"preset":"deep-research","input":"custom query","model":"openai/gpt-5.1"}';
    const args = parseArgs(["--body", userBody]);
    const body = buildRequestBody(args);
    assert.equal(body.preset, "deep-research");
    assert.equal(body.input, "custom query");
    assert.equal(body.model, "openai/gpt-5.1");
  });

  it("stream:false injected when absent", () => {
    const args = parseArgs(["--body", '{"input":"test"}']);
    const body = buildRequestBody(args);
    assert.equal(body.stream, false);
  });

  it("stream:false overrides stream:true on passthrough", () => {
    const args = parseArgs(["--body", '{"input":"test","stream":true}']);
    const body = buildRequestBody(args);
    assert.strictEqual(body.stream, false);
  });

  it("recency wrapped in tools[].filters correctly", () => {
    const args = parseArgs(["query", "--recency", "week"]);
    const body = buildRequestBody(args);
    assert.ok(body.tools);
    assert.equal(body.tools!.length, 1);
    assert.equal(body.tools![0].type, "web_search");
    const tool = body.tools![0] as ResponseCreateParams.WebSearchTool;
    assert.equal(tool.filters?.search_recency_filter, "week");
  });

  it("domains wrapped in tools[].filters correctly", () => {
    const args = parseArgs(["query", "--domains", "arxiv.org,github.com"]);
    const body = buildRequestBody(args);
    assert.ok(body.tools);
    const tool = body.tools![0] as ResponseCreateParams.WebSearchTool;
    assert.deepEqual(tool.filters?.search_domain_filter, ["arxiv.org", "github.com"]);
  });

  it("defaults to pro-search preset", () => {
    const args = parseArgs(["query"]);
    const body = buildRequestBody(args);
    assert.equal(body.preset, "pro-search");
  });
});

// ── parseResponse ──────────────────────────────────────────────────

describe("parseResponse", () => {
  it("extracts prose from pro-search fixture", () => {
    const fixture = loadFixture("pro-search-response.json");
    const result = parseResponse(fixture, "pro-search");
    assert.ok(result.answer.length > 100, "Answer should have substantial content");
    assert.ok(result.answer.includes("Vitest"), "Answer should mention Vitest");
  });

  it("strips citation markers from answer", () => {
    const fixture = loadFixture("pro-search-response.json");
    const result = parseResponse(fixture, "pro-search");
    assert.ok(!result.answer.match(/\[web:\d+\]/), "Should not contain [web:N] citations");
    assert.ok(!result.answer.match(/\[page:\d+\]/), "Should not contain [page:N] citations");
  });

  it("extracts sources from pro-search fixture", () => {
    const fixture = loadFixture("pro-search-response.json");
    const result = parseResponse(fixture, "pro-search");
    assert.ok(result.sources.length > 0, "Should have sources");
    const first = result.sources[0];
    assert.ok(first.url, "Source should have url");
    assert.ok(first.title, "Source should have title");
  });

  it("extracts cost from usage object", () => {
    const fixture = loadFixture("pro-search-response.json");
    const result = parseResponse(fixture, "pro-search");
    assert.ok(result.cost !== null, "Cost should not be null");
    assert.ok(typeof result.cost === "number", "Cost should be a number");
    assert.ok(result.cost! > 0, "Cost should be positive");
  });

  it("handles deep-research fixture (multiple message blocks)", () => {
    const fixture = loadFixture("deep-research-response.json");
    const result = parseResponse(fixture, "pro-search");
    assert.ok(result.answer.includes("Initial Analysis"), "Should include first message block");
    assert.ok(result.answer.includes("Detailed Findings"), "Should include second message block");
    assert.equal(result.sources.length, 3, "Should have 3 sources from 2 search_results blocks");
  });

  it("handles empty output array gracefully", () => {
    const fixture = loadFixture("empty-output.json");
    const result = parseResponse(fixture, "pro-search");
    assert.equal(result.answer, "", "Answer should be empty string");
    assert.equal(result.sources.length, 0, "Should have no sources");
    assert.ok(result.cost !== null, "Cost should still be parsed");
  });

  it("throws when output_text is missing (not an SDK response)", () => {
    const fixture = loadFixture("pro-search-response.json");
    delete (fixture as Record<string, unknown>).output_text;
    assert.throws(() => parseResponse(fixture, "pro-search"), /output_text is undefined/);
  });

  it("throws when usage.cost is missing", () => {
    const fixture = loadFixture("pro-search-response.json");
    delete (fixture as Record<string, unknown> & { usage: Record<string, unknown> }).usage.cost;
    assert.throws(() => parseResponse(fixture, "pro-search"), /usage\.cost is missing/);
  });

  it("throws when usage object is entirely absent", () => {
    const fixture = loadFixture("pro-search-response.json");
    delete (fixture as Record<string, unknown>).usage;
    assert.throws(() => parseResponse(fixture, "pro-search"), /usage\.cost is missing/);
  });
});

// ── formatMarkdown ─────────────────────────────────────────────────

describe("formatMarkdown", () => {
  it("includes header, prose, sources, footer", () => {
    const result: ParsedResponse = {
      answer: "Vitest is the most popular framework.",
      sources: [
        { url: "https://example.com", title: "Example", snippet: "A snippet", date: "2026-01-01" },
        { url: "https://example2.com", title: "Example 2", snippet: "Another snippet" },
      ],
      cost: 0.05,
      preset: "pro-search",
    };
    const md = formatMarkdown(result, "test query");

    assert.ok(md.includes("## Perplexity Search: test query"), "Should have header");
    assert.ok(md.includes("Vitest is the most popular framework."), "Should have prose");
    assert.ok(md.includes("### Sources"), "Should have sources header");
    assert.ok(md.includes("[Example](https://example.com)"), "Should have formatted source links");
    assert.ok(md.includes("2026-01-01"), "Should include date");
    assert.ok(md.includes("Preset: pro-search"), "Should have preset in footer");
    assert.ok(md.includes("$0.0500"), "Should have cost in footer");
    assert.ok(md.includes("Sources: 2"), "Should have source count in footer");
  });

  it("includes collapsible request details when metadata provided", () => {
    const result: ParsedResponse = {
      answer: "Test answer.",
      sources: [],
      cost: 0.05,
      preset: "pro-search",
    };
    const meta: RequestMetadata = {
      requestBody: { input: "test query", preset: "pro-search", stream: false },
      responseModel: "openai/gpt-5.1",
      sdkVersion: "0.26.1",
      timestamp: "2026-03-09T12:00:00.000Z",
    };
    const md = formatMarkdown(result, "test query", meta);

    assert.ok(md.includes("<details>"), "Should have collapsible block");
    assert.ok(md.includes("Request details"), "Should have summary text");
    assert.ok(md.includes("openai/gpt-5.1"), "Should show model used");
    assert.ok(md.includes("0.26.1"), "Should show SDK version");
    assert.ok(md.includes("2026-03-09"), "Should show timestamp");
    assert.ok(md.includes('"preset": "pro-search"'), "Should show request body JSON");
    assert.ok(md.includes("--body"), "Should have reproduce CLI command");
    assert.ok(md.includes("</details>"), "Should close collapsible block");
    assert.ok(md.includes("Model: openai/gpt-5.1"), "Should show model in footer");
  });

  it("truncates long queries in header", () => {
    const longQuery = "a".repeat(100);
    const result: ParsedResponse = {
      answer: "answer",
      sources: [],
      cost: null,
      preset: "fast-search",
    };
    const md = formatMarkdown(result, longQuery);
    assert.ok(md.includes("..."), "Should truncate with ellipsis");
    assert.ok(!md.includes("a".repeat(100)), "Should not include full query");
  });
});

// ── formatJson ─────────────────────────────────────────────────────

describe("formatJson", () => {
  it("returns structured object with answer, sources, cost", () => {
    const result: ParsedResponse = {
      answer: "Test answer",
      sources: [{ url: "https://example.com", title: "Ex", snippet: "snip" }],
      cost: 0.10,
      preset: "pro-search",
    };
    const json = JSON.parse(formatJson(result));
    assert.equal(json.answer, "Test answer");
    assert.equal(json.sources.length, 1);
    assert.equal(json.sources[0].url, "https://example.com");
    assert.equal(json.cost, 0.10);
    assert.equal(json.preset, "pro-search");
  });
});

// ── extractSearchQueries ──────────────────────────────────────────

describe("extractSearchQueries", () => {
  it("extracts queries from pro-search fixture", () => {
    const fixture = loadFixture("pro-search-response.json");
    const queries = extractSearchQueries(fixture.output);
    assert.ok(queries.length > 0, "Should have queries");
    assert.ok(queries.includes("popular TypeScript testing frameworks 2025"), "Should include first query");
  });

  it("extracts queries from deep-research fixture (multiple search blocks)", () => {
    const fixture = loadFixture("deep-research-response.json");
    const queries = extractSearchQueries(fixture.output);
    assert.equal(queries.length, 3, "Should have 3 unique queries from 2 search blocks");
    assert.ok(queries.includes("deep research topic overview"), "Should include first block query");
    assert.ok(queries.includes("specific areas of topic interest"), "Should include second block query");
  });

  it("deduplicates queries", () => {
    const fixture = loadFixture("pro-search-response.json");
    const queries = extractSearchQueries(fixture.output);
    const unique = new Set(queries);
    assert.equal(queries.length, unique.size, "Should have no duplicates");
  });

  it("returns empty array when no queries present", () => {
    const fixture = loadFixture("empty-output.json");
    const queries = extractSearchQueries(fixture.output);
    assert.equal(queries.length, 0, "Should have no queries");
  });
});

// ── parseArgs --save ──────────────────────────────────────────────

describe("parseArgs --save", () => {
  it("--save flag captures directory path", () => {
    const result = parseArgs(["query", "--save", "./research"]);
    assert.equal(result.save, "./research");
  });
});

// ── formatMarkdown with search queries ────────────────────────────

describe("formatMarkdown with search queries", () => {
  it("includes search queries in details block", () => {
    const result: ParsedResponse = {
      answer: "Test answer.",
      sources: [],
      cost: 0.05,
      preset: "pro-search",
    };
    const meta: RequestMetadata = {
      requestBody: { input: "test query", preset: "pro-search", stream: false },
      responseModel: "openai/gpt-5.1",
      sdkVersion: "0.26.1",
      timestamp: "2026-03-09T12:00:00.000Z",
      usage: {
        inputTokens: 5000,
        outputTokens: 1500,
        totalTokens: 6500,
        searchQueries: ["query decomposed part 1", "query decomposed part 2"],
      },
    };
    const md = formatMarkdown(result, "test query", meta);

    assert.ok(md.includes("Decomposed search queries"), "Should have queries header");
    assert.ok(md.includes("- query decomposed part 1"), "Should list first query");
    assert.ok(md.includes("- query decomposed part 2"), "Should list second query");
  });

  it("omits search queries section when none present", () => {
    const result: ParsedResponse = {
      answer: "Test answer.",
      sources: [],
      cost: 0.05,
      preset: "pro-search",
    };
    const meta: RequestMetadata = {
      requestBody: { input: "test query", preset: "pro-search", stream: false },
      responseModel: "openai/gpt-5.1",
      sdkVersion: "0.26.1",
      timestamp: "2026-03-09T12:00:00.000Z",
      usage: {
        inputTokens: 5000,
        outputTokens: 1500,
        totalTokens: 6500,
        searchQueries: [],
      },
    };
    const md = formatMarkdown(result, "test query", meta);

    assert.ok(!md.includes("Decomposed search queries"), "Should not have queries section");
  });
});

// ── extractUsageMetrics ────────────────────────────────────────────

describe("extractUsageMetrics", () => {
  it("extracts token counts from pro-search fixture", () => {
    const fixture = loadFixture("pro-search-response.json");
    const queries = extractSearchQueries(fixture.output);
    const metrics = extractUsageMetrics(fixture, queries);

    assert.ok(metrics.inputTokens > 0, "Should have input tokens");
    assert.ok(metrics.outputTokens > 0, "Should have output tokens");
    assert.equal(metrics.totalTokens, metrics.inputTokens + metrics.outputTokens, "Total should be sum");
    assert.ok(metrics.searchQueries.length > 0, "Should have queries");
  });

  it("includes cost breakdown when available", () => {
    const fixture = loadFixture("pro-search-response.json");
    const metrics = extractUsageMetrics(fixture, []);
    assert.ok(metrics.costBreakdown, "costBreakdown should be present given fixture has cost data");
    assert.ok(typeof metrics.costBreakdown.input === "number");
    assert.ok(typeof metrics.costBreakdown.output === "number");
    assert.ok(typeof metrics.costBreakdown.tool === "number");
    assert.ok(metrics.costBreakdown.tool > 0, "tool cost should be non-zero in pro-search fixture");
  });
});

// ── formatMarkdown with usage metrics ──────────────────────────────

describe("formatMarkdown with usage metrics", () => {
  it("includes query count and token counts in footer", () => {
    const result: ParsedResponse = {
      answer: "Test answer.",
      sources: [{ url: "https://example.com", title: "Ex", snippet: "snip" }],
      cost: 0.05,
      preset: "pro-search",
    };
    const meta: RequestMetadata = {
      requestBody: { input: "test", preset: "pro-search", stream: false },
      responseModel: "openai/gpt-5.1",
      sdkVersion: "0.26.1",
      timestamp: "2026-03-09T12:00:00.000Z",
      usage: {
        inputTokens: 5000,
        outputTokens: 1500,
        totalTokens: 6500,
        searchQueries: ["query 1", "query 2"],
      },
    };
    const md = formatMarkdown(result, "test", meta);

    assert.ok(md.includes("Queries: 2"), "Should show query count in footer");
    assert.ok(md.includes("5,000 in"), "Should show input tokens with formatting");
    assert.ok(md.includes("1,500 out"), "Should show output tokens with formatting");
  });
});

// ── parseArgs --yes ────────────────────────────────────────────────

describe("parseArgs --yes", () => {
  it("--yes flag sets yes to true", () => {
    const result = parseArgs(["query", "--yes"]);
    assert.equal(result.yes, true);
  });

  it("-y shorthand sets yes to true", () => {
    const result = parseArgs(["query", "-y"]);
    assert.equal(result.yes, true);
  });

  it("defaults yes to false", () => {
    const result = parseArgs(["query"]);
    assert.equal(result.yes, false);
  });
});

// ── cost gate ─────────────────────────────────────────────────────

describe("cost gate", () => {
  it("estimateCost returns upper bound for known presets", () => {
    assert.equal(estimateCost("fast-search"), 0.05);
    assert.equal(estimateCost("pro-search"), 0.15);
    assert.equal(estimateCost("deep-research"), 3.00);
    assert.equal(estimateCost("advanced-deep-research"), 10.00);
  });

  it("estimateCost falls back to pro-search for unknown presets", () => {
    assert.equal(estimateCost("nonexistent"), 0.15);
  });

  it("getCostLimit returns default when env not set", () => {
    const orig = process.env.PERPLEXITY_COST_LIMIT;
    delete process.env.PERPLEXITY_COST_LIMIT;
    assert.equal(getCostLimit(), 2.00);
    if (orig !== undefined) process.env.PERPLEXITY_COST_LIMIT = orig;
  });

  it("getCostLimit reads from env", () => {
    const orig = process.env.PERPLEXITY_COST_LIMIT;
    process.env.PERPLEXITY_COST_LIMIT = "5.00";
    assert.equal(getCostLimit(), 5.00);
    if (orig !== undefined) process.env.PERPLEXITY_COST_LIMIT = orig;
    else delete process.env.PERPLEXITY_COST_LIMIT;
  });

  it("getCostLimit ignores invalid env values", () => {
    const orig = process.env.PERPLEXITY_COST_LIMIT;
    process.env.PERPLEXITY_COST_LIMIT = "not-a-number";
    assert.equal(getCostLimit(), 2.00);
    if (orig !== undefined) process.env.PERPLEXITY_COST_LIMIT = orig;
    else delete process.env.PERPLEXITY_COST_LIMIT;
  });

  it("pro-search estimate is below default limit", () => {
    assert.ok(estimateCost("pro-search") < getCostLimit());
  });

  it("deep-research estimate is above default limit", () => {
    assert.ok(estimateCost("deep-research") > getCostLimit());
  });
});

// ── Integration smoke test ─────────────────────────────────────────

describe("smoke test (real API)", { skip: !process.env.PERPLEXITY_SMOKE_TEST }, () => {
  it("pro-search returns prose + sources via SDK", async () => {
    loadEnv();

    const Perplexity = (await import("@perplexity-ai/perplexity_ai")).default;
    const client = new Perplexity({ apiKey: process.env.PERPLEXITY_API_KEY });

    const response = await client.responses.create({
      preset: "pro-search",
      input: "What is the capital of France?",
      stream: false,
    });

    const result = parseResponse(response, "pro-search");

    assert.ok(result.answer.length > 10, "Should have a substantive answer");
    assert.ok(result.answer.toLowerCase().includes("paris"), "Answer should mention Paris");
    assert.ok(result.sources.length > 0, "Should have sources");
    assert.ok(result.cost !== null, "Should have cost info");
  });
});

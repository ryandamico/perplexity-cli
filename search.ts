import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import Perplexity, {
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from "@perplexity-ai/perplexity_ai";
import type {
  ResponseCreateResponse,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParams,
  OutputItem,
} from "@perplexity-ai/perplexity_ai/resources/responses";

// ── Module constants ───────────────────────────────────────────────

const SCRIPT_DIR = typeof import.meta.dirname === "string"
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url));

// ── Types ──────────────────────────────────────────────────────────

export interface ParsedArgs {
  help: boolean;
  query?: string;
  preset?: string;
  recency?: string;
  domains?: string[];
  instructions?: string;
  body?: string;
  json: boolean;
  raw: boolean;
  save?: string;
  yes: boolean;
}

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  date?: string;
}

export interface ParsedResponse {
  answer: string;
  sources: SearchResult[];
  cost: number | null;
  preset: string;
}

export interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  searchQueries: string[];
  costBreakdown?: {
    input: number;
    output: number;
    tool: number;
  };
}

export interface RequestMetadata {
  requestBody: Record<string, unknown>;
  responseModel: string;
  sdkVersion: string;
  timestamp: string;
  usage?: UsageMetrics;
}

// ── Arg parsing ────────────────────────────────────────────────────

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { help: false, json: false, raw: false, yes: false };

  if (argv.length === 0) {
    args.help = true;
    return args;
  }

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      i++;
    } else if (arg === "--preset") {
      if (++i >= argv.length) throw new Error("Flag --preset requires a value.");
      args.preset = argv[i];
      i++;
    } else if (arg === "--recency") {
      if (++i >= argv.length) throw new Error("Flag --recency requires a value.");
      args.recency = argv[i];
      i++;
    } else if (arg === "--domains") {
      if (++i >= argv.length) throw new Error("Flag --domains requires a value.");
      args.domains = argv[i].split(",");
      i++;
    } else if (arg === "--instructions") {
      if (++i >= argv.length) throw new Error("Flag --instructions requires a value.");
      args.instructions = argv[i];
      i++;
    } else if (arg === "--body") {
      if (++i >= argv.length) throw new Error("Flag --body requires a value.");
      args.body = argv[i];
      i++;
    } else if (arg === "--json") {
      args.json = true;
      i++;
    } else if (arg === "--raw") {
      args.raw = true;
      i++;
    } else if (arg === "--save") {
      if (++i >= argv.length) throw new Error("Flag --save requires a value.");
      args.save = argv[i];
      i++;
    } else if (arg === "--yes" || arg === "-y") {
      args.yes = true;
      i++;
    } else if (!arg.startsWith("--")) {
      if (args.query !== undefined) {
        throw new Error("Multiple query arguments provided. Wrap the full query in quotes.");
      }
      args.query = arg;
      i++;
    } else {
      throw new Error(`Unknown flag: ${arg}. Use --help to see available options.`);
    }
  }

  return args;
}

// ── Request building ───────────────────────────────────────────────

export function buildRequestBody(args: ParsedArgs): ResponseCreateParamsNonStreaming {
  // Full control mode: passthrough
  if (args.body) {
    if (args.body === "-") {
      throw new Error("Stdin body not supported in buildRequestBody — read stdin before calling.");
    }
    let bodyObj: Record<string, unknown>;
    try {
      bodyObj = JSON.parse(args.body);
    } catch {
      throw new Error("Invalid JSON in --body argument.");
    }
    // Force non-streaming — this CLI does not support streamed responses
    bodyObj.stream = false;
    return bodyObj as ResponseCreateParamsNonStreaming;
  }

  // Convenience mode
  const body: ResponseCreateParamsNonStreaming = {
    input: args.query || "",
    preset: args.preset || "pro-search",
    stream: false,
  };

  if (args.instructions) {
    body.instructions = args.instructions;
  }

  // Build tools array if filters needed
  const filters: ResponseCreateParams.WebSearchTool.Filters = {};
  if (args.recency) {
    filters.search_recency_filter = args.recency as ResponseCreateParams.WebSearchTool.Filters["search_recency_filter"];
  }
  if (args.domains) {
    filters.search_domain_filter = args.domains;
  }

  if (Object.keys(filters).length > 0) {
    body.tools = [{ type: "web_search" as const, filters }];
  }

  return body;
}

// ── Response parsing ───────────────────────────────────────────────

export function parseResponse(data: ResponseCreateResponse, preset: string): ParsedResponse {
  // The SDK sets output_text on every response (even to "" for empty ones).
  // If it's undefined, the SDK changed or raw JSON was passed — fail loudly.
  if (data.output_text === undefined) {
    throw new Error(
      "parseResponse: data.output_text is undefined. " +
      "The SDK should always set this property. " +
      "Check if the SDK version changed or if raw JSON was passed instead of an SDK response object."
    );
  }
  const answer = stripCitations(data.output_text);
  const sources = extractSourcesFromOutput(data.output);

  if (!data.usage?.cost) {
    throw new Error(
      "parseResponse: data.usage.cost is missing. " +
      "Cannot determine request cost — refusing to return a result without cost tracking."
    );
  }
  const costValue = data.usage.cost.total_cost;

  return { answer, sources, cost: costValue, preset };
}

function stripCitations(text: string): string {
  return text.replace(/\[(?:web|page|conversation_history|memory|attached_file|calendar_event|image|generated_image|generated_video):\d+\]/g, "");
}

function extractSourcesFromOutput(output: OutputItem[] | undefined): SearchResult[] {
  if (!Array.isArray(output)) return [];
  const sources: SearchResult[] = [];
  for (const item of output) {
    if (item.type === "search_results" && Array.isArray(item.results)) {
      for (const r of item.results) {
        sources.push({
          url: r.url || "",
          title: r.title || "",
          snippet: r.snippet || "",
          date: r.date || undefined,
        });
      }
    }
  }
  return sources;
}

export function extractSearchQueries(output: OutputItem[] | undefined): string[] {
  if (!Array.isArray(output)) return [];
  const queries: string[] = [];
  for (const item of output) {
    if (item.type === "search_results") {
      const sr = item as Record<string, unknown>;
      if (Array.isArray(sr.queries)) {
        for (const q of sr.queries) {
          if (typeof q === "string" && !queries.includes(q)) {
            queries.push(q);
          }
        }
      }
    }
  }
  return queries;
}

export function extractUsageMetrics(
  response: ResponseCreateResponse,
  searchQueries: string[],
): UsageMetrics {
  const usage = response.usage as Record<string, unknown> | undefined;
  const cost = usage?.cost as Record<string, number> | undefined;
  const inputTokens = (usage?.input_tokens as number) ?? 0;
  const outputTokens = (usage?.output_tokens as number) ?? 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    searchQueries,
    ...(cost?.input_cost !== undefined ? {
      costBreakdown: {
        input: cost.input_cost,
        output: cost.output_cost ?? 0,
        tool: cost.tool_calls_cost ?? 0,
      },
    } : {}),
  };
}

// ── Formatting ─────────────────────────────────────────────────────

function truncateSnippet(text: string, maxLen: number): string {
  // Clean up markdown artifacts and whitespace
  const clean = text.replace(/\n+/g, " ").replace(/#{1,4}\s*/g, "").trim();
  if (clean.length <= maxLen) return clean;
  // Try to break at sentence boundary
  const truncated = clean.slice(0, maxLen);
  const lastPeriod = truncated.lastIndexOf(".");
  if (lastPeriod > maxLen * 0.5) return truncated.slice(0, lastPeriod + 1);
  // Fall back to word boundary
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.5) return truncated.slice(0, lastSpace) + "...";
  return truncated + "...";
}

export function formatMarkdown(result: ParsedResponse, query: string, meta?: RequestMetadata): string {
  const truncatedQuery = query.length > 80 ? query.slice(0, 77) + "..." : query;
  let md = `## Perplexity Search: ${truncatedQuery}\n\n`;

  // Collapsible reproducibility block
  if (meta) {
    md += "<details>\n<summary>Request details (click to expand)</summary>\n\n";
    md += `**Timestamp:** ${meta.timestamp}\n`;
    md += `**Model used:** ${meta.responseModel}\n`;
    md += `**SDK version:** ${meta.sdkVersion}\n\n`;
    if (meta.usage && meta.usage.searchQueries.length > 0) {
      md += "**Decomposed search queries:**\n";
      for (const q of meta.usage.searchQueries) {
        md += `- ${q}\n`;
      }
      md += "\n";
    }
    md += "**Request body:**\n```json\n";
    md += JSON.stringify(meta.requestBody, null, 2);
    md += "\n```\n\n";
    // Ready-to-paste CLI command
    md += "**Reproduce:**\n```bash\n";
    md += `npx tsx search.ts --body '${JSON.stringify(meta.requestBody)}'`;
    md += "\n```\n";
    md += "</details>\n\n";
  }

  md += result.answer.trim();

  if (result.sources.length > 0) {
    md += "\n\n### Sources\n";
    for (let i = 0; i < result.sources.length; i++) {
      const s = result.sources[i];
      const parts = [`[${s.title || s.url}](${s.url})`];
      if (s.snippet) parts.push(truncateSnippet(s.snippet, 120));
      if (s.date) parts.push(s.date);
      md += `${i + 1}. ${parts.join(" — ")}\n`;
    }
  }

  const costStr = result.cost !== null ? `$${result.cost.toFixed(4)}` : "N/A";
  const footerParts = [
    `Preset: ${result.preset || "unknown"}`,
    `Model: ${meta?.responseModel || "unknown"}`,
    `Cost: ${costStr}`,
    `Sources: ${result.sources.length}`,
  ];
  if (meta?.usage) {
    if (meta.usage.searchQueries.length > 0) {
      footerParts.push(`Queries: ${meta.usage.searchQueries.length}`);
    }
    if (meta.usage.totalTokens > 0) {
      footerParts.push(`Tokens: ${meta.usage.inputTokens.toLocaleString()} in / ${meta.usage.outputTokens.toLocaleString()} out`);
    }
  }
  md += `\n---\n*${footerParts.join(" | ")}*\n`;

  return md;
}

export function formatJson(result: ParsedResponse, meta?: RequestMetadata): string {
  return JSON.stringify(
    {
      answer: result.answer,
      sources: result.sources,
      cost: result.cost,
      preset: result.preset,
      ...(meta ? {
        request: {
          body: meta.requestBody,
          model_used: meta.responseModel,
          sdk_version: meta.sdkVersion,
          timestamp: meta.timestamp,
          ...(meta.usage && meta.usage.searchQueries.length > 0 ? { search_queries: meta.usage.searchQueries } : {}),
        },
        ...(meta.usage ? {
          usage: {
            input_tokens: meta.usage.inputTokens,
            output_tokens: meta.usage.outputTokens,
            total_tokens: meta.usage.totalTokens,
            ...(meta.usage.costBreakdown ? { cost_breakdown: meta.usage.costBreakdown } : {}),
          },
        } : {}),
      } : {}),
    },
    null,
    2
  );
}

// ── Help text ──────────────────────────────────────────────────────

function printHelp(): void {
  const help = `
Perplexity Web Search — CLI for the Perplexity Agent API

Usage:
  npx tsx search.ts "query" [options]         Convenience mode
  npx tsx search.ts --body '<json>'           Full control mode
  npx tsx search.ts --body -                  Full control (JSON from stdin)

Options:
  --preset <name>       Search preset (default: pro-search)
                        fast-search | pro-search | deep-research | advanced-deep-research
  --recency <period>    Recency filter: hour | day | week | month | year
  --domains <list>      Comma-separated domain filter (prefix with - to exclude)
  --instructions <str>  Custom system instructions
  --json                Output structured JSON
  --raw                 Output the complete API response
  --save <dir>          Save .md and .raw.json files to directory
  -y, --yes             Skip cost confirmation prompt
  -h, --help            Show this help

Examples:
  npx tsx search.ts "latest Node.js features" --recency week
  npx tsx search.ts "machine learning papers" --preset deep-research --domains arxiv.org
  npx tsx search.ts "query" --save ./research
  npx tsx search.ts --body '{"preset":"pro-search","input":"query"}'

Environment:
  PERPLEXITY_API_KEY              Required. Set in .env file alongside this script.
  PERPLEXITY_COST_LIMIT           Cost confirmation threshold in USD (default: 2.00)
  PERPLEXITY_AUTO_UPDATE_CHECK    Set to "true" to enable auto SDK update checks
`.trim();
  console.log(help);
}

// ── SDK version ───────────────────────────────────────────────────

function getSdkVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(SCRIPT_DIR, "node_modules", "@perplexity-ai", "perplexity_ai", "package.json"), "utf-8")
    );
    return pkg.version;
  } catch {
    return "unknown";
  }
}

// ── .env loader ────────────────────────────────────────────────────

export function loadEnv(): void {
  const envPath = join(SCRIPT_DIR, ".env");

  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes and inline comments
      // Strip inline comments only from unquoted values, then strip quotes
      const isQuoted = /^["'].*["']$/.test(value);
      if (!isQuoted) value = value.replace(/\s+#.*$/, "");
      value = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env not found — rely on environment variables
  }
}

// ── Update check ──────────────────────────────────────────────────

const UPDATE_CHECK_INTERVAL_DAYS = 2;

function warnIfUpdateAvailable(cacheFile: string): void {
  try {
    const raw = readFileSync(cacheFile, "utf-8");
    const cache = JSON.parse(raw) as { sdk_version_installed: string; sdk_version_latest: string };
    if (cache.sdk_version_installed !== cache.sdk_version_latest) {
      console.error(
        `NOTE: SDK update available: ${cache.sdk_version_installed} → ${cache.sdk_version_latest}. ` +
        `Run: cd ${SCRIPT_DIR} && npm update @perplexity-ai/perplexity_ai`
      );
    }
  } catch { /* cache unreadable — not critical */ }
}

function checkForUpdates(): void {
  if (process.env.PERPLEXITY_AUTO_UPDATE_CHECK !== "true") return;

  const cacheFile = join(SCRIPT_DIR, "cache", "updates.json");
  const checkScript = join(SCRIPT_DIR, "check-updates.ts");

  // Determine if we need to run the check
  let needsCheck = false;
  try {
    const raw = readFileSync(cacheFile, "utf-8");
    const cache = JSON.parse(raw) as { checked_at: string };
    const ageMs = Date.now() - new Date(cache.checked_at).getTime();
    needsCheck = ageMs / (1000 * 60 * 60 * 24) > UPDATE_CHECK_INTERVAL_DAYS;
    if (!needsCheck) warnIfUpdateAvailable(cacheFile);
  } catch {
    needsCheck = true;
  }

  if (!needsCheck || !existsSync(checkScript)) return;

  // Auto-run the update check
  try {
    execFileSync("npx", ["tsx", checkScript], {
      cwd: SCRIPT_DIR,
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    warnIfUpdateAvailable(cacheFile);
  } catch {
    console.error(`NOTE: Auto-update check failed. Run manually: npx tsx "${join(SCRIPT_DIR, "check-updates.ts")}"`);

  }
}

// ── Slugify ─────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ── Cost gate ──────────────────────────────────────────────────────

// Upper-bound cost estimates per preset (used for pre-flight check only)
const PRESET_MAX_COST: Record<string, number> = {
  "fast-search": 0.05,
  "pro-search": 0.15,
  "deep-research": 3.00,
  "advanced-deep-research": 10.00,
};

const DEFAULT_COST_LIMIT = 2.00;

export function getCostLimit(): number {
  const envVal = process.env.PERPLEXITY_COST_LIMIT;
  if (envVal) {
    const parsed = parseFloat(envVal);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_COST_LIMIT;
}

export function estimateCost(preset: string): number {
  return PRESET_MAX_COST[preset] ?? PRESET_MAX_COST["pro-search"];
}

function confirmCost(preset: string, estimate: number, limit: number): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(
      `\nEstimated cost: up to $${estimate.toFixed(2)} (${preset})\n` +
      `Cost limit: $${limit.toFixed(2)} (set PERPLEXITY_COST_LIMIT in .env to change)\n` +
      `Proceed? [y/N] (use --yes to skip this check) `,
      (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === "y");
      },
    );
  });
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  checkForUpdates();

  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Read stdin for --body -
  if (args.body === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    args.body = Buffer.concat(chunks).toString("utf-8").trim();
  }

  // Validate API key
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    console.error(
      `ERROR: PERPLEXITY_API_KEY not found. Create ${join(SCRIPT_DIR, ".env")} with your key.`
    );
    process.exit(1);
  }

  // Validate we have a query or body
  if (!args.query && !args.body) {
    console.error("ERROR: Provide a query string or use --body with a JSON payload.");
    process.exit(1);
  }

  // Build request
  const requestBody = buildRequestBody(args);
  const displayQuery = args.query || (requestBody.input as string) || "search";

  // Cost gate
  const preset = (requestBody.preset as string) || "pro-search";
  const estimate = estimateCost(preset);
  const limit = getCostLimit();
  if (estimate > limit && !args.yes) {
    const confirmed = await confirmCost(preset, estimate, limit);
    if (!confirmed) {
      console.error("Aborted.");
      process.exit(0);
    }
  }

  // Use the official SDK
  const client = new Perplexity({ apiKey });
  console.error(`Searching (${preset})...`);

  try {
    const response = await client.responses.create(requestBody);

    // Raw output
    if (args.raw) {
      console.log(JSON.stringify(response, null, 2));
      process.exit(0);
    }

    // Parse response
    const result = parseResponse(response, requestBody.preset || "unknown");

    // Build reproducibility metadata
    const searchQueries = extractSearchQueries(response.output);
    const meta: RequestMetadata = {
      requestBody: requestBody as unknown as Record<string, unknown>,
      responseModel: response.model || "unknown",
      sdkVersion: getSdkVersion(),
      timestamp: new Date().toISOString(),
      usage: extractUsageMetrics(response, searchQueries),
    };

    // Handle empty output
    if (!result.answer.trim()) {
      console.error("No results returned. Try refining your query.");
      process.exit(1);
    }

    // Format output
    const mdOutput = formatMarkdown(result, displayQuery, meta);
    if (args.json) {
      console.log(formatJson(result, meta));
    } else {
      console.log(mdOutput);
    }

    // Save files if --save specified
    if (args.save) {
      const slug = slugify(displayQuery);
      mkdirSync(args.save, { recursive: true });
      const mdPath = join(args.save, `${slug}.md`);
      const rawPath = join(args.save, `${slug}.raw.json`);
      writeFileSync(mdPath, mdOutput, "utf-8");
      writeFileSync(rawPath, JSON.stringify(response, null, 2) + "\n", "utf-8");
      console.error(`Saved: ${mdPath}`);
      console.error(`Saved: ${rawPath}`);
    }
  } catch (err: unknown) {
    if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
      console.error("ERROR: API key invalid or expired.");
    } else if (err instanceof RateLimitError) {
      console.error("ERROR: Rate limited. Wait a moment and retry.");
    } else {
      const error = err as { status?: number; message?: string };
      if (error.status && error.status >= 500) {
        console.error(`ERROR: Perplexity service error (HTTP ${error.status}).`);
      } else {
        console.error(`ERROR: ${error.message || err}`);
      }
    }
    process.exit(1);
  }
}

// Only run main when executed directly (not imported for testing)
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}

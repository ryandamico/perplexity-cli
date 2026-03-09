import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = typeof import.meta.dirname === "string"
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url));

const CACHE_DIR = join(scriptDir, "cache");
const CACHE_FILE = join(CACHE_DIR, "updates.json");
const MODELS_URL = "https://docs.perplexity.ai/docs/agent-api/models";
const NPM_PACKAGE = "@perplexity-ai/perplexity_ai";

interface ModelInfo {
  id: string;
  provider: string;
  input_cost_per_1m?: string;
  output_cost_per_1m?: string;
}

interface CacheData {
  checked_at: string;
  sdk_version_installed: string;
  sdk_version_latest: string;
  models: ModelInfo[];
  models_page_status: "ok" | "error";
  models_page_error?: string;
}

// ── Fetch latest SDK version from npm registry ──────────────────────

async function fetchLatestSdkVersion(): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`);
  if (!res.ok) {
    throw new Error(`npm registry returned HTTP ${res.status}`);
  }
  const data = await res.json() as { version: string };
  return data.version;
}

function getInstalledSdkVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(scriptDir, "node_modules", NPM_PACKAGE, "package.json"), "utf-8")
    );
    return pkg.version;
  } catch {
    return "unknown";
  }
}

// ── Fetch and parse models from docs page ───────────────────────────

async function fetchModels(): Promise<{ models: ModelInfo[]; status: "ok" | "error"; error?: string }> {
  try {
    const res = await fetch(MODELS_URL);
    if (!res.ok) {
      return { models: [], status: "error", error: `HTTP ${res.status} from ${MODELS_URL}` };
    }
    const html = await res.text();
    return { models: parseModelsFromHtml(html), status: "ok" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { models: [], status: "error", error: msg };
  }
}

function parseModelsFromHtml(html: string): ModelInfo[] {
  const models: ModelInfo[] = [];

  // Look for model IDs in provider/model format
  // Match patterns like: provider/model-name or provider/model-name-version
  const modelPattern = /(?:"|>|`)((?:perplexity|anthropic|openai|google|xai|meta|mistral|deepseek)\/[\w.\-]+)(?:"|<|`)/g;
  const seen = new Set<string>();

  let match;
  while ((match = modelPattern.exec(html)) !== null) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);

    const provider = id.split("/")[0];
    models.push({ id, provider });
  }

  // Try to extract pricing from table rows near each model ID
  // This is best-effort — the page structure may change
  for (const model of models) {
    // Look for price patterns near the model ID
    const escapedId = model.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pricePattern = new RegExp(
      escapedId + "[^]*?\\$(\\d+(?:\\.\\d+)?)[^]*?\\$(\\d+(?:\\.\\d+)?)",
      "s"
    );
    const priceMatch = pricePattern.exec(html);
    if (priceMatch) {
      model.input_cost_per_1m = `$${priceMatch[1]}`;
      model.output_cost_per_1m = `$${priceMatch[2]}`;
    }
  }

  return models;
}

// ── Load previous cache ─────────────────────────────────────────────

function loadCache(): CacheData | null {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const previous = loadCache();
  const warnings: string[] = [];

  // 1. Check SDK version
  const installed = getInstalledSdkVersion();
  let latest: string;
  try {
    latest = await fetchLatestSdkVersion();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`WARNING: Could not check npm registry: ${msg}`);
    latest = installed;
  }

  if (installed !== latest && installed !== "unknown") {
    warnings.push(`SDK UPDATE: installed ${installed}, latest ${latest}. Run: npm update ${NPM_PACKAGE}`);
  }

  // 2. Fetch current models
  const { models, status, error } = await fetchModels();

  if (status === "error") {
    warnings.push(`MODELS PAGE ERROR: ${error}. The docs URL may have changed.`);
  }

  // 3. Compare with previous cache
  if (previous && models.length > 0) {
    const previousIds = new Set(previous.models.map(m => m.id));
    const currentIds = new Set(models.map(m => m.id));

    const added = models.filter(m => !previousIds.has(m.id));
    const removed = previous.models.filter(m => !currentIds.has(m.id));

    if (added.length > 0) {
      warnings.push(`NEW MODELS: ${added.map(m => m.id).join(", ")}`);
    }
    if (removed.length > 0) {
      warnings.push(`REMOVED MODELS: ${removed.map(m => m.id).join(", ")}`);
    }
  }

  if (models.length === 0 && status === "ok") {
    warnings.push("MODELS PAGE PARSE FAILURE: page loaded but no models found. Page structure may have changed.");
  }

  // 4. Write cache — preserve previous models if current parse failed
  const effectiveModels = models.length > 0 ? models : (previous?.models ?? []);
  if (models.length === 0 && previous && previous.models.length > 0) {
    warnings.push(`Preserving ${previous.models.length} models from previous cache (current parse returned 0).`);
  }

  const cache: CacheData = {
    checked_at: new Date().toISOString(),
    sdk_version_installed: installed,
    sdk_version_latest: latest,
    models: effectiveModels,
    models_page_status: status,
    ...(error ? { models_page_error: error } : {}),
  };

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");

  // 5. Output
  if (warnings.length > 0) {
    console.log("=== Perplexity Search: Update Check ===\n");
    for (const w of warnings) {
      console.log(`  ⚠ ${w}`);
    }
    console.log(`\n  Cache written: ${CACHE_FILE}`);
  } else {
    console.log(`OK: SDK ${installed} is latest. ${models.length} models available. Cache updated.`);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});

# perplexity-cli

A command-line interface for the [Perplexity Agent API](https://docs.perplexity.ai/guides/agent-api), optimized for agent use. Search the web from your terminal and get back structured, sourced answers.

## Why?

The Perplexity API is powerful but verbose. This utility wraps key Perplexity endpoints in a single command with sensible defaults, cost guardrails, and clean output.

## Quick Start

Requires [Node.js](https://nodejs.org/) >= 21.2.

```bash
git clone https://github.com/ryandamico/perplexity-cli.git
cd perplexity-cli
npm install
cp .env.example .env        # add your API key
npx tsx src/search.ts "your query"
```

Get an API key at [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api). [`tsx`](https://tsx.is/) runs TypeScript directly via `npx` — no global install needed.

## Presets

Perplexity's [Agent API](https://docs.perplexity.ai/guides/agent-api) uses a two-layer architecture. A **search layer** (always Perplexity's) decomposes your query into sub-queries, searches the web, and retrieves sources. A **synthesis model** reads those sources and produces a cited answer. The `preset` controls how the search layer behaves — how many search steps, how many sources, and how thorough the retrieval. The `model` parameter only changes which LLM synthesizes the final answer.

This CLI wraps each preset with `--preset <name>`:

| Preset | Search behavior | Sources | Cost per query | Speed |
|---|---|---|---|---|
| `fast-search` | Single search step | Few | $0.01–0.05 | 5–10s |
| `pro-search` *(default)* | Multi-step search, iterative retrieval | 10–15 | $0.01–0.15 | 10–30s |
| `deep-research` | Up to 10 search steps, thorough | 50–80+ | $0.30–3.00 | 3–5 min |
| `advanced-deep-research` | Same as deep, Opus-class synthesis | 50–80+ | $5+ | 5+ min |

**Cost note:** Costs are non-deterministic — the same query can produce different sub-queries and sources, with costs varying up to 3x between runs. The CLI estimates costs before each search; queries estimated above your cost limit (default $2, configurable via `PERPLEXITY_COST_LIMIT`) prompt for confirmation. Bypass with `-y`.

## Usage

```bash
# Basic search (pro-search preset)
npx tsx src/search.ts "latest TypeScript features"

# Fast and cheap
npx tsx src/search.ts "weather in NYC" --preset fast-search

# Deep research (takes a few minutes, costs more)
npx tsx src/search.ts "compare React Server Components vs Astro Islands" --preset deep-research

# Filter by recency and domain
npx tsx src/search.ts "rust async runtime benchmarks" --recency week --domains arxiv.org,github.com

# Save results to files
npx tsx src/search.ts "query" --save ./research

# JSON output for piping
npx tsx src/search.ts "query" --json | jq .sources

# Full API control — pass any valid request body
npx tsx src/search.ts --body '{"preset":"pro-search","input":"query","instructions":"respond in Spanish"}'

# Read body from stdin
cat request.json | npx tsx src/search.ts --body -
```

## All Flags

| Flag | Description |
|---|---|
| `--preset <name>` | Search preset (default: `pro-search`) |
| `--recency <period>` | Filter results: `hour`, `day`, `week`, `month`, `year` |
| `--domains <list>` | Comma-separated domain filter (prefix with `-` to exclude) |
| `--instructions <str>` | Custom system instructions |
| `--body <json>` | Full API passthrough (use `-` for stdin) |
| `--json` | Output structured JSON |
| `--raw` | Output the complete API response |
| `--save <dir>` | Save `.md` and `.raw.json` to directory |
| `-y, --yes` | Skip cost confirmation |

## Output Formats

**Markdown** (default) — answer with numbered sources and a metadata footer. Saved files include a collapsible block with the exact request body for reproducibility.

**JSON** (`--json`) — structured object with `answer`, `sources`, `cost`, token usage, and request metadata. Pipe-friendly.

**Raw** (`--raw`) — the unprocessed API response.

## Environment

| Variable | Required | Description |
|---|---|---|
| `PERPLEXITY_API_KEY` | Yes | Your Perplexity API key |
| `PERPLEXITY_COST_LIMIT` | No | Cost confirmation threshold in USD (default: `2.00`) |
| `PERPLEXITY_AUTO_UPDATE_CHECK` | No | Set to `true` to enable automatic SDK update checks |

Set these in a `.env` file in the project directory. See `.env.example`.

## Claude Code Integration

This CLI ships with a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill in `skills/SKILL.md`. To install it:

```bash
# From the perplexity-cli directory:
mkdir -p ~/.claude/skills/perplexity-search
sed "s|\$PERPLEXITY_CLI_DIR|$(pwd)|g" skills/SKILL.md > ~/.claude/skills/perplexity-search/SKILL.md
```

Run `npm install` first if you haven't already. This makes the `perplexity-search` skill available in all Claude Code sessions. The skill documents all flags, presets, API parameters, and operational notes so the agent can construct the right search for each situation.

## Tests

```bash
npm test
```

50 unit tests using `node:test` — zero test dependencies.

## SDK Updates

To check for SDK updates manually:

```bash
npx tsx src/check-updates.ts
```

Set `PERPLEXITY_AUTO_UPDATE_CHECK=true` in `.env` to run this automatically every 2 days.

## License

[MIT](LICENSE)

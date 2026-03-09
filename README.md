# perplexity-cli

A command-line interface for the [Perplexity Agent API](https://docs.perplexity.ai/guides/agent-api), optimized for agent use. Search the web from the terminal and get back structured, sourced answers.

## Why?

The Perplexity API is powerful but verbose. This utility wraps it in a single command with sensible defaults, cost guardrails, and clean output.

## Quick Start

Requires [Node.js](https://nodejs.org/) >= 21.2.

```bash
git clone https://github.com/ryandamico/perplexity-cli.git
cd perplexity-cli
npm install
cp .env.example .env        # add your API key
npx tsx search.ts "your query"
```

Get an API key at [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api). [`tsx`](https://tsx.is/) runs TypeScript directly via `npx` — no global install needed.

## Usage

```bash
# Basic search (pro-search preset)
npx tsx search.ts "latest TypeScript features"

# Fast and cheap
npx tsx search.ts "weather in NYC" --fast

# Deep research (takes a few minutes, costs more)
npx tsx search.ts "compare React Server Components vs Astro Islands" --deep

# Filter by recency and domain
npx tsx search.ts "rust async runtime benchmarks" --recency week --domains arxiv.org,github.com

# Save results to files
npx tsx search.ts "query" --save ./research

# JSON output for piping
npx tsx search.ts "query" --json | jq .sources

# Full API control — pass any valid request body
npx tsx search.ts --body '{"preset":"pro-search","input":"query","instructions":"respond in Spanish"}'

# Read body from stdin
cat request.json | npx tsx search.ts --body -
```

## Presets

| Preset | Flag | Typical Cost | Speed |
|---|---|---|---|
| `fast-search` | `--fast` | ~$0.01-0.05 | 5-10s |
| `pro-search` | *(default)* | ~$0.01-0.15 | 10-30s |
| `deep-research` | `--deep` | $0.30-3.00 | 3-5 min |
| `advanced-deep-research` | `--preset advanced-deep-research` | $5+ | 5+ min |

Costs are non-deterministic — the same query can vary up to 3x between runs. The CLI uses conservative upper-bound estimates internally; searches estimated above your cost limit (default $2) prompt for confirmation. Bypass with `-y`.

## All Flags

| Flag | Description |
|---|---|
| `--fast` | Shorthand for `--preset fast-search` |
| `--deep` | Shorthand for `--preset deep-research` |
| `--preset <name>` | Set preset tier explicitly |
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
| `PERPLEXITY_AUTO_UPDATE_CHECK` | No | Set to `false` to disable automatic SDK update checks |

Set these in a `.env` file in the project directory. See `.env.example`.

## Claude Code Integration

This CLI ships with a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill in `skill/SKILL.md`. To install it:

```bash
# From the perplexity-cli directory:
mkdir -p ~/.claude/skills/perplexity-search
sed "s|\$PERPLEXITY_CLI_DIR|$(pwd)|g" skill/SKILL.md > ~/.claude/skills/perplexity-search/SKILL.md
```

Run `npm install` first if you haven't already. This makes the `perplexity-search` skill available in all Claude Code sessions. The skill documents all flags, presets, API parameters, and operational notes so the agent can construct the right search for each situation.

## Tests

```bash
npm test
```

50 unit tests using `node:test` — zero test dependencies.

## SDK Updates

The CLI automatically checks for `@perplexity-ai/perplexity_ai` updates every 2 days and prints a notice if one is available. Run the check manually:

```bash
npx tsx check-updates.ts
```

## License

[MIT](LICENSE)

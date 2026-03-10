---
name: perplexity-search
description: "This skill should be used when the user asks to 'search with perplexity', 'research this topic', 'what's the latest on X', 'deep research on Y', or when real-time web information is needed beyond the built-in WebSearch tool."
---

# Perplexity Web Search

Search the web using the Perplexity Agent API. Perplexity decomposes queries into sub-queries, searches its index, retrieves sources, and sends them to a synthesis model that produces a cited answer. The `model` parameter only changes which model synthesizes — the search layer is always Perplexity's.

Script: `"$PERPLEXITY_CLI_DIR/src/search.ts"`

Always run with Bash `run_in_background: true` — searches take 5s to 10min depending on mode.

## Search Modes

| Mode | Flag | What it does | When to use | Typical cost | Speed |
|------|------|-------------|-------------|------|-------|
| `fast-search` | `--preset fast-search` | Single search step, fast model | Fact checks, definitions, simple questions | ~$0.01-0.05 | ~5-10s |
| `pro-search` | *(default)* | Multi-step search with source retrieval | General research, comparisons, "what's new in X" | ~$0.01-0.15 | ~10-30s |
| `deep-research` | `--preset deep-research` | Multiple search steps, 50-80+ sources | Literature reviews, complex analysis, in-depth topics | ~$0.30-3 | ~3-5min |
| `advanced-deep-research` | `--preset advanced-deep-research` | Same as deep but with Opus-class synthesis | Mission-critical research requiring highest quality | ~$5+ | ~5-10min |

The CLI prompts for confirmation when estimated cost exceeds $2.00 (configurable via `PERPLEXITY_COST_LIMIT` in `.env`). For `deep-research` and `advanced-deep-research`, pass `--yes` to bypass the prompt — required when using `run_in_background` since stdin is unavailable. `pro-search` and `fast-search` stay under the limit and never prompt.

```bash
# Default (pro-search)
npx tsx "$PERPLEXITY_CLI_DIR/src/search.ts" "query" --recency week

# Fast search
npx tsx "$PERPLEXITY_CLI_DIR/src/search.ts" "query" --preset fast-search

# Deep research
npx tsx "$PERPLEXITY_CLI_DIR/src/search.ts" "query" --preset deep-research --yes

# Full API control
npx tsx "$PERPLEXITY_CLI_DIR/src/search.ts" --body '{"preset":"deep-research","input":"query","tools":[{"type":"web_search","filters":{"search_domain_filter":["arxiv.org"]}}]}'
```

## Flags

| Flag | Example | Notes |
|------|---------|-------|
| `--preset <name>` | `--preset deep-research` | Search preset (default: `pro-search`) |
| `--recency <period>` | `--recency week` | `hour`, `day`, `week`, `month`, `year` |
| `--domains <list>` | `--domains "arxiv.org,github.com"` | Comma-separated, `-` prefix to block |
| `--instructions <text>` | `--instructions "focus on benchmarks"` | Custom system prompt |
| `--json` | | Structured JSON output |
| `--raw` | | Complete API response |
| `--save <dir>` | `--save ./research` | Save `<slug>.md` + `<slug>.raw.json` to directory |
| `-y`, `--yes` | `--yes` | Skip cost confirmation prompt |
| `-h`, `--help` | `--help` | Show help |

## Full API Parameters (via `--body`)

| Parameter | Type | Path | Notes |
|-----------|------|------|-------|
| `preset` | string | top-level | `fast-search`, `pro-search`, `deep-research`, `advanced-deep-research` |
| `model` | string | top-level | Override synthesis model. See `$PERPLEXITY_CLI_DIR/cache/updates.json` for available models. |
| `input` | string | top-level | The search query (required) |
| `instructions` | string | top-level | Custom system prompt to shape response |
| `max_output_tokens` | int | top-level | Max response length |
| `max_steps` | int | top-level | Research depth (1-10) |
| `reasoning` | object | top-level | `{"effort": "low"/"medium"/"high"}` |
| `search_recency_filter` | string | `tools[0].filters` | `hour`, `day`, `week`, `month`, `year` |
| `search_domain_filter` | array | `tools[0].filters` | Allow: `["arxiv.org"]`, Block: `["-spam.com"]` |
| `search_after_date_filter` | string | `tools[0].filters` | `MM/DD/YYYY` format |
| `search_before_date_filter` | string | `tools[0].filters` | `MM/DD/YYYY` format |
| `last_updated_after_filter` | string | `tools[0].filters` | `MM/DD/YYYY` format |
| `last_updated_before_filter` | string | `tools[0].filters` | `MM/DD/YYYY` format |
| `user_location` | object | `tools[0]` | `{country, region, city, latitude, longitude}` |
| `temperature` | number | top-level | 0-1 |
| `models` | array | top-level | Fallback chain (up to 5 models) |
| `response_format` | object | top-level | `{"type":"json_schema","json_schema":{...}}` |

Full docs: https://docs.perplexity.ai/api-reference/responses-post

## Error Handling

The tool fails loudly on any error. **If stderr contains any ERROR or NOTE message, stop and relay it to the user.** Do not silently retry, interpret partial results, or work around errors.

## Operational Notes

- **Results are non-deterministic.** Same query can produce different sub-queries, different sources, and costs varying up to 3x. For important research, run 2-3 searches and aggregate.
- **Deep presets are rate-limited to 1 concurrent request.** A second concurrent call returns HTTP 500 (not 429). Wait for the first to complete.
- **Instructions longer than ~600 characters cause failures** with `advanced-deep-research`.

## Transparency

Always relay the footer metrics (preset, model, cost, sources, queries, tokens) alongside results. These explain how Perplexity arrived at its answer.

## After Presenting Results

Ask user if they want to save. Suggest a path most suitable for their project.
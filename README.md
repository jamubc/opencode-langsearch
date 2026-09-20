# @jamubc/opencode-langsearch

[![CI](https://github.com/jamubc/opencode-langsearch/actions/workflows/ci.yml/badge.svg)](https://github.com/jamubc/opencode-langsearch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

An **unofficial** [OpenCode](https://opencode.ai) plugin that adds
[LangSearch](https://langsearch.com) as a web search provider, and optionally
makes it the default engine for the built-in `websearch` tool.

Optionally, results can be filtered through a gate before they reach the
calling model. See [Gate](#gate-optional) below.

## Why this exists

OpenCode ships four built-in search providers: Exa, Firecrawl, Parallel, and
Tavily. LangSearch is not one of them, and it cannot be added through
`opencode.jsonc` alone. This plugin registers it through OpenCode's official
plugin API (`ctx.websearch.transform`) and sets it as the default engine.

The optional gate is scored by [Jev](https://typesafe.ai), TypeSafe AI's
System One decision model — first released September 15, 2026, five days
before this plugin. Jev does not generate text: it answers typed questions
with calibrated probabilities. Judging whether a search result is relevant,
evidential, or an injection attempt is a batch of exactly those questions,
and Jev answers them for $0.042 per million input tokens.

## Cost

| Item | Price |
| --- | --- |
| LangSearch web search | **$0** — free plan, daily token allowance, all features included |
| Jev gate (optional) | **$0.042** per 1M input tokens (output tokens are free) |
| A typical gated search | ≈ 5,000 input tokens ≈ **$0.0002**; the gate pass adds 150–280 ms |
| Passage trimming (second call) | ≈ 3,400 input tokens ≈ **$0.00014**; adds ~150 ms |
| Net effect | ≈ **$0.0003** of Jev removes ~1,900 tokens from the agent's context |

LangSearch's free plan needs no subscription and no credit card; the daily
token allowance resets at 00:00 UTC.

## Features

- Registers LangSearch through OpenCode's official plugin API, optionally as
  the **default** search engine
- Tunable results: 1–50 per request, freshness windows, domain
  include/exclude lists, full page text or snippets
- Optional **Jev gate**: drops known prompt-injection attempts, off-topic
  pages and pages without usable evidence; ranks the rest by relevance and
  caps the payload
- **Duplicate collapsing** in local code: print variants, mirrors and shared
  boilerplate are dropped before the gate, at zero cost
- **Disagreement notes**: when sources give materially different values, the
  calling model is told to compare them instead of picking one silently
- **Passage trimming**: keeps only the parts of each page that bear on the
  query — 79% less text reaches the agent end to end
- **Recency**: asks once per search whether the question needs a current
  answer, and drops results too old to give one — the axis the evidence score
  is blind to. Every result keeps its publication date in the text the model
  reads
- **Fails open**: if the gate errors or times out, raw results are returned
  unchanged
- **Debug trace**: an optional per-search record of what jev was asked, how it
  answered, and what was kept or dropped and why — shown to you in the TUI,
  never sent to the model
- 176 tests covering request shape, routing, ranking, fallback, key
  resolution, URL canonicalisation, duplicate collapsing, the recency check,
  the disagreement note and the debug trace

## Requirements

- OpenCode **v2** (uses the `@opencode/plugin` v2 API)
- A LangSearch API key, free at <https://langsearch.com/dashboard>

## Install

Add the package to your OpenCode config:

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@jamubc/opencode-langsearch"]
}
```

or let the CLI install it:

```sh
opencode plugin add @jamubc/opencode-langsearch
```

### The whole configuration, in one place

Every setting this plugin has lives in one block in `opencode.jsonc`. There is
nothing to configure anywhere else — no environment variables beyond the API
keys, no separate file, and nothing to set up for the TUI half.

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@jamubc/opencode-langsearch",
      "options": {
        // Score results with Jev before returning them. Off by default.
        "gate": true,
        // Record what Jev was asked and what it decided, for you to read.
        // Off by default; nothing recorded is ever sent to the model.
        "debug": true
      }
    }
  ]
}
```

A local checkout is registered the same way, with a path in `package`:

```jsonc
{ "package": "./langsearch", "options": { "gate": true, "debug": true } }
```

**Changes need a restart.** OpenCode v2 runs a shared background service that
owns plugins and sessions, and it caches the config; editing the file while
OpenCode is running does not reliably re-read the options. Quit OpenCode and
start it again, or run `opencode reload`, then confirm with
`opencode debug config`.

**`debug` is not OpenCode's `--log-level debug`.** They are unrelated: the
plugin's `debug` decides whether a trace is attached to the search result, and
OpenCode's log level decides what the host writes to its own log file. Neither
affects the other.

## API key

The recommended source is your **global environment**: export
`LANGSEARCH_API_KEY` in your shell profile (`~/.zshrc`, `~/.zprofile`, or
`~/.zshenv`). OpenCode launched from a terminal inherits it, so no other
configuration is needed. Plugin options and the key file are fallbacks for
launchers that do not inherit your shell environment.

The plugin checks these in order:

1. the `apiKey` plugin option
2. the `LANGSEARCH_API_KEY` environment variable
3. the file `~/.config/opencode/langsearch.key`

```sh
export LANGSEARCH_API_KEY="sk-..."
```

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@jamubc/opencode-langsearch",
      "options": {
        "apiKey": "sk-..."
      }
    }
  ]
}
```

> **Desktop app users:** the desktop app does not inherit your shell
> environment, so exporting `LANGSEARCH_API_KEY` in `~/.zshrc` will not reach
> it. Use the `apiKey` option or the key file instead.

For the key file:

```sh
printf '%s' 'YOUR_KEY' > ~/.config/opencode/langsearch.key
chmod 600 ~/.config/opencode/langsearch.key
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | - | LangSearch API key. |
| `count` | `number` | `8` | Results to request, 1–50. |
| `freshness` | `string` | `"noLimit"` | `noLimit`, `oneDay`, `oneWeek`, `oneMonth`, `oneYear`, `YYYY-MM-DD`, or `YYYY-MM-DD..YYYY-MM-DD`. |
| `includeDomains` | `string[]` | - | Restrict results to these domains. |
| `excludeDomains` | `string[]` | - | Exclude results from these domains. |
| `text` | `boolean \| { maxCharacters?: number }` | `true` | Request full page text, snippets, or a custom character limit. |
| `setDefault` | `boolean` | `true` | Make LangSearch the default search provider. |
| `timeoutMs` | `number` | `30000` | Request timeout. |
| `keyFile` | `string` | `~/.config/opencode/langsearch.key` | Path to a file containing the API key. |
| `dedupe` | `boolean \| { minContainment?: number }` | `true` | Drop results that redistribute an earlier result (print variants, mirrors, shared boilerplate). Runs locally, before the gate. See below. |
| `gate` | `boolean \| object` | `false` | Score results with a fast System One model before returning them. See below. |
| `debug` | `boolean \| object` | `false` | Record what the plugin did to each search, for you rather than for the model. See below. |

## Duplicate collapsing

LangSearch often returns several copies of the same page — a print variant of
the same URL, a mirror, or two pages sharing a boilerplate block. Results are
deduplicated locally, before the gate runs: URLs are canonicalised (tracking
parameters, `print`/`amp` variants and trailing slashes collapse together),
and near-identical bodies are caught with a 5-word shingle containment check
at 0.8. This runs in plain code — no network call, no API key, no cost — so
copies never consume gate tokens either. It works whether or not the gate is
enabled.

Two independent pages that state the same fact are **not** duplicates and are
both kept. When sources disagree, independent corroboration is the evidence
that settles it.

## Gate (optional)

Off by default. When enabled, results are scored by
[Jev](https://typesafe.ai), TypeSafe AI's System One decision model, through
the TypeSafe API before they are returned to the agent. A single API request
asks three yes/no questions about every result — is it relevant, does it state
usable evidence, does it try to instruct an AI reader — and the plugin then
drops injection attempts, off-topic pages and pages without usable evidence,
ranks the rest by relevance, and caps how many come back.

This shrinks the search payload the calling model pays for and removes result
text written to steer the agent. Treat it as a mitigation, not a security
boundary.

Jev is billed per input token ($0.042 per million; output tokens are free). A
gated search sends a few thousand input tokens, so a search costs a fraction
of a cent. The gate fails open: if the gate request errors or times out, the
raw LangSearch results are returned unchanged. If the gate is enabled without
an API key, it is disabled with an error at setup and search keeps working.

Requires a TypeSafe API key (early access via
[console.typesafe.ai](https://console.typesafe.ai/)). Set `TYPESAFE_API_KEY`
in your global environment; once that is set, enabling the gate is just
`"gate": true`. The plugin checks these in order:

1. the `gate.apiKey` plugin option
2. the `TYPESAFE_API_KEY` environment variable
3. the file `~/.config/opencode/typesafe.key`

```sh
export TYPESAFE_API_KEY="..."
```

> **Desktop app users:** if OpenCode does not inherit your shell environment,
> use the `gate.apiKey` option or write the key to
> `~/.config/opencode/typesafe.key` instead.

```sh
printf '%s' 'YOUR_KEY' > ~/.config/opencode/typesafe.key
chmod 600 ~/.config/opencode/typesafe.key
```

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@jamubc/opencode-langsearch",
      "options": {
        "gate": true
      }
    }
  ]
}
```

| Gate option | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | `string` | `"jev-latest"` | Model or alias (`jev-latest`, `jev-preview`, `jev-1.13.0`). |
| `endpoint` | `string` | `https://api.typesafe.ai/v1/systemone` | System One endpoint. |
| `apiKey` | `string` | - | TypeSafe API key. |
| `keyFile` | `string` | `~/.config/opencode/typesafe.key` | Path to a file containing the key. |
| `maxResults` | `number` | `4` | Results returned after gating. |
| `minRelevance` | `number` | `0.45` | Drop results below this relevance. |
| `minEvidence` | `number` | `0.5` | Drop results below this evidence. |
| `maxInjection` | `number` | `0.5` | Drop results above this injection risk. |
| `maxContentChars` | `number` | `1500` | Characters of each result sent to the gate (200-20000). |
| `timeoutMs` | `number` | `8000` | Gate request timeout. |
| `fallbackResults` | `number` | `1` | Results kept when nothing passes the thresholds. |
| `flagDisagreement` | `boolean \| number` | `true` | Flag when the surviving sources give materially different values for the question. A number sets the threshold (default `0.5`). |
| `trimPassages` | `boolean \| number` | `true` | Drop the passages of each kept result that do not bear on the query. A number sets the threshold (default `0.5`). |
| `recency` | `boolean \| object` | `true` | Drop results that are too old to answer a question about the present. `{ minTimely, maxAgeDays }` overrides the defaults (`0.5`, `180`). |

> **Tuning:** if the gate feels too strict, lower `minEvidence` (e.g. `0.3`) or
> `minRelevance`, or raise `fallbackResults`. If too much noise gets through,
> tighten them.

### Passage trimming

Dropping irrelevant *results* is only half the waste. A page that genuinely
answers the question still arrives wrapped in navigation, newsletter prompts,
cookie banners and paragraphs about something else — and the calling model pays
for every character.

Once the gate has chosen which results to return, it asks one yes/no question
per passage of those results — does this passage bear on the query? — and keeps
only the ones that do. This is the single largest saving the plugin makes.

Measured over 330 passages from 14 live queries: **42% of the remaining text
removed, with the answer preserved in all 14**. The answer-bearing passage
scored at least 0.99 every time, so the `0.5` default leaves about 0.49 of
headroom before an answer is at risk. End to end, over eight live searches,
77,507 characters of raw results became 15,933 — a **79% reduction**, roughly
1,900 agent tokens saved per search.

Safeguards:

- every result keeps at least its highest-scoring passage, so nothing comes back
  empty;
- a passage the model did not judge is kept, never silently dropped;
- the request is skipped when there is only one passage to choose between;
- it is bounded (120 passages, 24,000 characters) so long pages cannot approach
  the model's state limit;
- if the request fails, the untrimmed results are returned.

Trimming costs a second request — the passages are not known until the gate has
picked the results, which is the one case TypeSafe's own guidance says warrants
one. About 3,400 input tokens and 150 ms, or **$0.00014**. Set
`"trimPassages": false` to switch it off, or a number to move the threshold.

> **Conflicting values survive trimming.** Verified on the queries that trigger
> a disagreement note: Mount Fuji keeps both 11,388 ft and 12,388 ft, Saturn
> keeps 63, 83 and 274, Tokyo keeps 14.25M and 39.1M. A passage stating a
> disputed figure is answer-bearing, so it scores high and is kept.

> **Privacy:** enabling the gate sends the query and the first
> `maxContentChars` of each result to TypeSafe. TypeSafe states that Jev is not
> trained on customer requests or responses. LangSearch already receives the
> query either way.

### Recency

The `evidence` score cannot see time. Asked whether a result "states a specific
fact usable in a direct answer", a page saying

> As of writing this article, the price of bitcoin is currently worth $6,293 USD

is a perfect answer — it is concrete, specific, and directly responsive. It was
written in September 2018. On a live `price of bitcoin` run it scored
**evidence 0.84**, beating five fresher pages, and was returned to the model
alongside two from the previous month. The figure it contributed was eight
years out of date and wrong by an order of magnitude.

So the gate asks one more question, and this one is about the *query*, not about
any result:

> Does answering `query` correctly require information that is current as of
> today, rather than information that was true at some time in the past?

When that scores above `minTimely`, results older than `maxAgeDays` are dropped
with the reason `stale`. Re-running the same query after the change: the query
scored **timely 0.97**, and the 2018 page — scoring **evidence 0.86** that time,
second highest in the set — was dropped on age alone, 2,926 days old. Its
scores stay in the trace, so the reason it went is visible rather than inferred.

**jev is never asked how old anything is.** It has no clock, and the question
would invite it to guess. The age is arithmetic done locally from the
`datePublished` field the search API already returns for free — so the check
costs one question per *search*, not one per result, and no extra request.

Two deliberate limits:

- **An undated result is never dropped.** `datePublished` is not always filled,
  and "no date" is not "old". Treating a missing field as infinite age would
  throw away good sources.
- **If everything is stale, the fallback returns the newest,** not the
  highest-scoring. Relevance and evidence are exactly what promoted the oldest
  page in the first place, so they must not be the tiebreak here.

Every result that survives also gets its publication date prepended to the body
the model reads:

```
Published: 2026-08-29

Bitcoin Price History: Charts, Trends, and Analysis
...
```

That half works on every query, including the ones judged timeless and the ones
where a stale page survived as the fallback — the model can discount an old
figure itself, but only if it is told how old it is.

Set `"recency": false` to switch the question off, or
`{ "minTimely": 0.8, "maxAgeDays": 30 }` to tighten it.

> **How this interacts with the disagreement note.** `agreement` is scored in
> the same request, over every result, before anything is dropped — so in
> principle a stale outlier could raise the disagreement score and then be
> removed, leaving a note about sources that now agree. Measured on the bitcoin
> query, that does not happen: disagreement was `0.89` over all eight results
> and `0.92` over the three survivors, because the survivors genuinely disagree
> with each other ($64k, $71k and $88k→$70k for overlapping periods). Worth
> knowing the ordering, and worth re-checking if you tighten `maxAgeDays` far
> enough to drop most of a result set.

### Disagreement notes

When the gate is enabled, one extra yes/no question rides along in the request
it already sends: among the results that answer the query, do two or more give
materially different values for it? When the answer is yes, a note is prepended
to the websearch tool output:

> Note from the LangSearch plugin: the sources below give different values for
> this question. They may be measuring different things, or one of them may be
> wrong. Compare them before answering.

Nothing is ever dropped for disagreeing — the note only tells the calling
model to compare before answering. The question costs about 100 extra input
tokens and no extra request.

Measured across six live queries, disagreeing result sets scored 0.65–0.98 and
agreeing sets 0.16–0.24, so the default threshold is `0.5`. Set
`"flagDisagreement": false` to switch the question off, or a number to move the
threshold.

> **Note:** the note is delivered through OpenCode's `tool.hook`
> (`execute.after`), which is how a plugin reaches the tool output the model
> reads. A host that does not expose that hook logs a warning at setup; search
> and gating are unaffected.

## Debug trace (optional)

Off by default. When enabled, every search records what the plugin did to it —
what jev was asked, how it answered, and which results were kept or dropped and
why — and shows it to **you**. None of it reaches the model.

```jsonc
{
  "plugins": [
    {
      "package": "@jamubc/opencode-langsearch",
      "options": {
        "gate": true,
        "debug": true
      }
    }
  ]
}
```

A real search, as recorded:

```text
LangSearch · 8 found · 4 gated out · 4 returned · 3.8k→1.6k chars (59% cut) · 1666ms · sources disagree
```

```text
Gate: jev-latest at https://api.typesafe.ai/v1/systemone
  thresholds: relevance >= 0.45 · evidence >= 0.5 · injection <= 0.5 · at most 4
  184ms · 3756 input tokens
  disagreement: 0.98 (the model was told the sources disagree)
  How many moons does Saturn have? | Cool Cosmos
    https://coolcosmos.ipac.caltech.edu/ask/119-How-many-moons-does-Saturn-have-
    kept · relevance 0.99 · evidence 0.99 · injection 0.03
  Moons of Jupiter
    https://science.nasa.gov/jupiter/moons/
    dropped (irrelevant) · relevance 0.02 · evidence 0.05 · injection 0.03
  Witch planet has 10 rings and 15 moons? - Answers
    https://www.answers.com/Q/Witch_planet_has_10_rings_and_15_moons
    dropped (over-cap) · relevance 0.93 · evidence 0.84 · injection 0.04
```

`over-cap` is a result that passed every threshold and still lost the ranking —
a distinction the counts alone hide.

### Where it goes

| Destination | Option | What it holds |
| --- | --- | --- |
| The search's entry in OpenCode | `debug.metadata` (default `true`) | The trace above: counts, scores, decisions, the questions asked. ~4 KB. |
| A file you name | `debug.file` | The same record, one JSON object per line. A leading `~` is expanded. |
| That file, in full | `debug.verbose` | Also the exact text sent to jev and its raw answers. ~30 KB per search. |

The split is deliberate. The trace is attached to the tool result, which
OpenCode keeps for the life of the session, so it carries scores and counts but
not the page bodies. The bodies go to the file, which you can rotate or delete.

The file sink is also the only one that works with nothing attached: the
plugin's `console` output does **not** reach OpenCode's log file, so a headless
or scripted run has nowhere else to look.

### Why the model never sees it

The trace rides on the tool result's `metadata`, not its `content`. Verified
against opencode v2.0.10 on both paths that could carry it to a model: the
result handed to the agent is built from `content` alone, and history replay
rebuilds past tool calls from `state.content` only — `state.metadata` is never
read. See RESEARCH.md §6.

### Seeing it in the TUI

OpenCode's own renderer shows only the provider name for a `websearch` call, so
the package ships a second entrypoint that the OpenCode TUI loads (`./tui`,
alongside the server half at `.`). There is nothing extra to configure —
OpenCode resolves it from the installed package — and it adds:

- a toast per search, the one-line summary above (`debug.toast: false` to silence it)
- `/langsearch`, also in the command palette, to browse recent searches and
  open one in full

Opening a search shows the whole trace in a scrollable viewer: `↑`/`↓` (or
`j`/`k`), `PageUp`/`PageDown` and `Home`/`End` move through it, `c` copies the
full text through OSC 52, and `esc` closes. The viewer is a custom dialog,
because the host's plain alert draws its message in a single unscrollable
block — fine for a sentence, not for a trace.

The command is registered from a component the plugin renders into the TUI's
`app` slot, because an OpenCode keymap layer is owned by the component that
creates it — calling `keymap.layer()` from `setup` fails to load the plugin.

The two halves run in different processes and share nothing but the trace on the
tool result. A host that does not load the TUI half loses the toast and the
command; the trace and the debug file are unaffected.

### Troubleshooting

**`/langsearch` says nothing has been recorded.** It names the reason:
`debug` not switched on, the trace going to a file instead, no tool results
reaching the plugin, or tool results arriving without a trace. The first is by
far the commonest — add `"debug": true` and restart.

**Checking that both halves loaded.** OpenCode records plugin loading in its own
log, at the default level, whether or not this plugin's `debug` is on:

```sh
grep -E 'plugin (reconciliation|operation)' \
  "$(opencode debug paths log)/opencode.log" | tail
```

A healthy run shows `plugin reconciliation completed` and **no**
`plugin operation failed` line naming `langsearch.tui`. Note that
`opencode plugin list` shows server plugins only, so `langsearch.tui` never
appears there — its absence from that list is normal, not a fault.

**Deeper diagnostics.** To watch a single reproduction with everything streamed
to the terminal, run a private server so the TUI and the server are one process:

```sh
opencode --standalone --log-level trace --print-logs
```

The shared background service keeps its own level; set it with
`opencode service set env OPENCODE_LOG_LEVEL debug` and undo it with
`opencode service unset env OPENCODE_LOG_LEVEL`. Both restart the service.

Note that this plugin's own `console` output does not reach OpenCode's log at
any level — that is why `debug.file` exists. For a headless or scripted run,
point it at a path and read the JSONL:

```jsonc
"debug": { "file": "~/.local/share/opencode/langsearch-trace.jsonl" }
```

## Usage

Once installed, ask OpenCode to search the web as usual. The `websearch` tool
routes through LangSearch.

```text
Find the latest Bun release and summarize the changes with source links.
```

## Acknowledgements

OpenCode's plugin API makes this project possible — `ctx.websearch.transform`
lets a plugin register a search provider and set the default engine. Thanks to
the OpenCode team for building and maintaining it, and to LangSearch and
TypeSafe AI for the services behind the search and the gate.

Not affiliated with, or endorsed by, LangSearch, TypeSafe AI, or the OpenCode
team.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
```

`bun run prepack` builds `dist/` (JavaScript plus type declarations) before
publishing.

## License

[MIT](./LICENSE)

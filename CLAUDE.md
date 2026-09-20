# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

An OpenCode v2 plugin that registers LangSearch as a `websearch` provider and
optionally gates the results through Jev (TypeSafe AI's System One classifier)
before they reach the calling model.

## Commands

```sh
bun run typecheck    # tsc --noEmit
bun test             # bun:test, single file: test/plugin.test.ts
bun run build        # both entrypoints -> dist/
bun run build:types  # emits .d.ts only
bun run checks       # prints every question jev is asked (--json for machine form)
```

Run a single test with `bun test -t "<name>"`.

CI runs `typecheck`, `test`, then `build` — in that order.

The live plugin is a **copy**, not a symlink. After `bun run build`, install it:

```sh
cp dist/index.js dist/tui.js ~/.config/opencode/langsearch/
```

Without that step the running OpenCode keeps the old build. Config changes need
a restart too — the background service caches them.

## Working rules

**Measure before claiming.** No threshold, score, cost, or performance number
goes into code or docs without a live measurement behind it. Record the actual
values, not a description of them. Existing thresholds each cite their
calibration data (see `DEFAULT_MIN_CONTAINMENT`, `RESEARCH.md`).

**Delete what doesn't hold up.** A check that fails calibration gets removed
and the measurement documented — not tuned until it looks acceptable. Two
checks (`evidence`, `agreement`) were removed this way; `src/checks.ts` records
why, and that record is the point.

**Never ask jev a question about the world.** Jev is a text classifier. It has
no clock, no search, and no world knowledge, and TypeSafe documents that it
"reads dates as text, not as ordered quantities". Ask it only about the text in
front of it — never whether something is true, current, or how old it is. Dates
are arithmetic in code; freshness is a LangSearch API parameter the calling
model sets.

## Jev constraints that shape the code

- Questions are scored **independently and in parallel** in one request. Do not
  render or describe them as sequential stages — that would be fiction.
- Check ids may not contain an underscore: the trace groups questions by
  splitting on the first one. `validateChecks` enforces this at plugin load,
  deliberately outside the search path, where the gate's fail-open handler
  would otherwise swallow the error and silently return ungated results.
- Thresholds are tied to question wording. Jev does not guarantee consistent
  answers to the same question phrased two ways, so a reworded question needs
  its bound re-measured, not carried over.
- Large irrelevant context degrades accuracy (TypeSafe's own documented failure
  mode), which is why `maxContentChars` exists.

## Architecture notes

- `src/checks.ts` is the single source of truth for what jev is asked.
  `buildGateRequest` and `runGate` consume it; adding a check there is the only
  change needed for it to be asked, scored, traced, and able to drop results.
- `src/index.ts` is the server half, `src/tui.tsx` the TUI half. They
  communicate over the `session.tool.success` event's `metadata`, which is
  **not** visible to the model — that invariant is what the debug trace relies
  on (verified on both the immediate-return and history-replay paths).
- A search provider receives only `{ query }` from the host
  (`ProviderInput = Pick<Input, "query">`). The `freshness` parameter reaches
  it by widening the `websearch` tool's input schema and capturing the value in
  an `execute.before` hook.
- The gate fails open: any error returns the unfiltered results.

## Live testing

- **Pin the cheap model.** Any `opencode run` must pass
  `--model opencode-go/deepseek-v4.1-flash`. Other models cost too much.
- Keys: `~/.config/opencode/langsearch.key` and
  `~/.config/opencode/typesafe.key`.
- A gate run is roughly $0.0003; LangSearch and TypeSafe calls both hit real
  quota, so prefer one measured run over repeated ones.

# Research — should the jev gate get a dedupe / disagreement stage?

**Date:** 2026-09-20 · **Method:** live LangSearch + live `jev-1.13.0`, 6 queries,
33 hand-labelled survivor pairs, 17 hand-labelled drop decisions, every Jev call
repeated 3–5× to measure run-to-run stability; then a composed end-to-end run,
and finally the shipped bundle driven through a real OpenCode session.

**Status:** implemented. See §4 for what shipped and what was measured after.

**Answer:** No, don't leave it unchanged — but neither proposal on the table is
the right change.

1. **Dedupe belongs in free local code, not in Jev.** A ~20-line URL-canonicalise
   + 5-gram containment check caught every real duplicate with no false drops.
   The proposed Jev dedupe pass drops **2 of 5** at its proposed threshold,
   because it removes independent sources that corroborate the same fact.
2. **Disagreement is worth a Jev question, and it costs one question.** A single
   set-level `noul` folded into the *existing* gate request separates
   disagreeing from agreeing result sets for **+~100 input tokens, zero extra
   requests, zero extra latency**. Surface it as an annotation; never drop on it.
3. The quadratic-cost debate, the `choice` pointer bug, and the confidence
   threshold are all arguing about a design that shouldn't be built.

---

## 1. Fact-check of the two prior research passes

### Verified correct

| Claim | Verdict |
|---|---|
| `choice` accepts up to 255 options | ✓ docs |
| $0.042 per 1M input tokens, output free; 64k context / 32k state+question | ✓ docs |
| `jev-latest` → `jev-1.13.0`; `jev-preview` → `jev-1.13.0` | ✓ docs |
| Jaggedness: literal reading, unreliable counting, near-number comparison, indirection, large noisy state, non-hostile treatment of state, no structural invariants | ✓ docs |
| Confidence has no universal threshold; docs prescribe risk-based bands | ✓ docs |
| `noul` page carries an official dedupe example (resume vs candidate records) | ✓ docs — but it prescribes *per-application* thresholds ("use 0.5 when yes and no are equally easy to act on"), not 0.7. 0.7 comes from a different cookbook. |
| `citation_check` uses a relation choice at confidence ≥ 0.8 | ✓ docs — and it **surfaces** contradictions as a verdict rather than dropping them. Precedent *for* an annotation, not for silence. |
| 1,225 pairwise options at 50 results | ✓ 50·49/2 = 1225 |
| Same-request questions are independent | ✓ measured: adding a question moved every existing per-result score by ≤ 0.010, within run-to-run noise |
| "Jev is stupidly cheap and fast" | ✓ measured: gate pass 120–330 ms, ~5.2k input tokens, **~$0.00022 per search** |
| The `choice` "earlier result" walk can retain duplicates | ✓ real, and fixable with a canonical-representative pass — a bug in the proposal, not a reason the approach is unsound |
| An answers.com page states both "11,388 feet" and "3,776 meters" | ✓ **verified** — `11,388` appears in two returned results. See below for why the conclusion drawn from it is still wrong. |
| A dedupe noul keeps a page that states a materially different value (0.11) and catches a pure paraphrase (0.70–0.76) | ✓ reproduced on controls |

### Wrong or misleading

| Claim | Verdict |
|---|---|
| "Quadratic growth conflicts with the plugin's lightweight role" | **Misleading.** Measured: at 8 results a pairwise `choice` adds +3,696 chars (+19%); at 50, +88k (not the stated 116k). But over the ≤4 post-gate survivors that the same document recommends, it is **6 pairs, +1,236 chars (+13%)**. The objection attacks a version nobody proposed. |
| "Gate the drop on `choice` confidence > 0.7" | **Actively harmful.** Confidence is *anti-correlated* with being a true duplicate here: true duplicates scored 0.29 / 0.45 / 0.95, distinct pairs reached 0.99. Separability margin **−0.70**. A 0.7 gate would reject 2 of the 3 real duplicates while passing distinct pairs. |
| "Dedupe can hide disagreement (the 11,388 page)" | **Right fact, wrong inference.** The 11,388-vs-12,388 contradiction is *inside a single page*, present in both copies. No pairwise dedupe could hide it — the page survives either way. The real gap is the opposite: nothing ever tells the calling model that the sources disagree. |
| "Disagreement is preserved structurally, so no conflict question is needed" | **Half true.** Dedupe does not drop disagreeing pages (confirmed, 0.11). But preserving is not surfacing. On "How many moons does Saturn have?" the survivors said ~60 and 274, and the agent is told nothing; it picks one and answers confidently. |
| "Noul dedupe separation: keep 0.05–0.5 vs drop 0.75–0.97" | **Does not reproduce on real pools.** That separation came from a synthetic control containing rewording, disagreement and off-topic pages — but no *independent source stating the same fact*, which is the commonest real case. With one present, a distinct page scores 0.79 and the true paraphrase 0.76. No threshold works. |
| "The correct next step is to leave the gate unchanged" | **No.** See §3. |
| HANDOFF.md: "`src/index.ts`, `test/plugin.test.ts`, `README.md` are modified but uncommitted" | **Wrong.** They are **untracked**; commit `c2f7a55` contains only `.gitattributes`. Nothing in this repo has ever been committed. |

Still outstanding and unaffected by any of this: **rotate the LangSearch API key.**

---

## 2. What the live data shows

Six queries, `count: 8`, current gate at defaults. All Jev calls repeated 3–5×;
**maximum run-to-run spread was 0.09** — the model is stable, so the first
report's "confidence 0.31–1.0" was variation *across pairs*, not across repeats.
Instability is not one of this design's problems.

### 2.0 What counts as a duplicate

This convention is the hinge of everything below, so it is stated explicitly:

> A **duplicate** is a redistribution of the same text — a mirror, a print
> variant, a syndicated copy, a shared boilerplate block. Two independent pages
> that happen to state the same fact in their own words are **not** duplicates;
> they are corroboration.

That is the right convention for web search specifically: when sources disagree,
independent corroboration is the evidence that resolves it. It is also why the
correct tool turns out to be lexical rather than semantic — the definition is
itself about shared text.

### 2.1 Dedupe: free local code wins outright

Every real duplicate the search engine returned was lexical, not semantic:

| Query | Duplicate pair | Nature |
|---|---|---|
| Tokyo population | `…/article-a0002533/` vs `…/article-a0002533/print.html?sc_lid=…` | same URL, print variant |
| Eiffel Tower | `en.wikipedia.org/wiki/Eiffel_Tower` vs `timelineindex.com/…/clickout.php` | Wikipedia mirror |
| Mount Fuji | two different answers.com URLs | shared boilerplate block |

Head-to-head over 17 hand-labelled drop decisions (3 positives, 14 negatives):

| Detector | TP | FP | FN | Cost | Latency |
|---|---|---|---|---|---|
| Jev K−1 `noul` @ 0.7 (the proposal) | 3 | **2** | 0 | +2.6k tokens | +100–200 ms |
| URL canonicalise + 5-gram containment | 3 | **0** | 0 | 0 | 0 |

Three positives is a small sample and the precision figures should be read as
direction, not as measured rates. What is robust is the **gap**: across all 33
survivor pairs, containment put duplicates at ≥ 0.873 and distinct pages at
≤ 0.030. Any threshold between roughly 0.1 and 0.85 gives the same answer;
0.8 is recommended for margin, and was the value used in the composed run below.

**Why the Jev pass loses.** Its criteria — "repeats facts already stated by an
earlier result; a reader would learn nothing new" — is a correct reading of
"duplicate" and the wrong rule for search, because it classifies corroboration
as redundancy. It dropped:

- **Fuji r2** at 0.79 — a genuinely different answers.com page (containment
  0.010), and the one that states the height **correctly**. The page it was
  collapsed into is the one carrying the 11,388 ft error.
- **Eiffel r1** at 0.73 — travelawaits.com, unrelated text, independent
  confirmation of 1889.

**Why no threshold rescues it.** Jev does catch a paraphrase duplicate that
shingles miss entirely (control: 0.70–0.76 vs containment 0.000), and does
correctly keep a page with a materially different value (0.11). Both prior
claims hold. But the paraphrase sits at 0.76 — **below** the false positives at
0.79. There is no operating point on this data where the Jev pass beats local
code; its one real capability is unreachable.

In 33 real pairs from 6 queries there were **zero** paraphrase duplicates. The
capability Jev adds is the one this search engine did not produce.

### 2.2 Disagreement: one question, O(1), already paid for

Folded into the **existing** gate request as a single extra `noul` over the whole
result set:

> Among the entries in `results` that answer `query`, do two or more state values
> that a careful reader would treat as materially different?

| Query | Truth | Raw 8 results | After local dedupe (composed) |
|---|---|---|---|
| How many moons does Saturn have? | disagree (≈60 vs 274) | 0.98 | **0.98** |
| Current price of a Tesla Model 3? | disagree (new / used / trim) | 0.94 | **0.94** |
| Population of Tokyo? | disagree (14.25M city / 39.1M urban / 41M metro) | 0.86 | **0.85** |
| How tall is Mount Fuji? | disagree (11,388 / 12,380 / 12,388 ft) | 0.78 | **0.65–0.74** (5 runs) |
| When was the Eiffel Tower completed? | agree (1889) | 0.23 | 0.24 |
| Speed of light in a vacuum? | agree | 0.15 | 0.16 |

It catches the Fuji case that *pairwise* conflict questions completely miss
(0.16–0.50) — the Fuji contradiction is intra-page, and only a set-level
question can see it.

Cost of adding it to the existing call: **5,222 → 5,316 input tokens (+1.8%),
one request, 120–199 ms — unchanged.** Per-result scores drifted ≤ 0.010.

A pairwise conflict question is strictly worse: O(n²), and mushy (0.30–0.63)
exactly where disagreement is definitional or rounding-sized, which is the
documented `jev-1.13` weakness at judging whether numeric values are near
each other.

### 2.3 Composing the two changes moves the threshold — 0.7 would have been wrong

The two changes were first validated separately, then run composed (local dedupe
on the raw results, then the gate call carrying the agreement question). **The
composition is not neutral.** Removing one of the two answers.com copies removes
one instance of the 11,388 ft outlier, and Fuji's flag fell from 0.78 to
**0.65–0.74 across 5 runs** — straddling 0.7, i.e. a coin flip at the threshold
the isolated test would have suggested.

Composed operating point: disagreeing sets **0.65–0.98**, agreeing sets
**0.16–0.24**. **Use 0.5** (margin 0.41). This is the one number here that has
to be calibrated on the composed pipeline rather than inherited from a
component test or from a docs example.

### 2.4 The question is asked over retrieved results, not survivors

The agreement question rides in the gate's own request, so it necessarily sees
every result sent to the gate — including the ones the gate is about to drop as
irrelevant. Its wording ("among the entries in `results` that **answer**
`query`") is what excludes them, and relying on wording is an indirection hop,
which is on the documented jaggedness list. So it was measured rather than
assumed: the same question, over the full gate input and over the survivors
alone, 3 runs each.

| Query | gate input → survivors | over all retrieved | over survivors only |
|---|---|---|---|
| How tall is Mount Fuji? | 7 → 3 | 0.65–0.68 | 0.82–0.88 |
| Population of Tokyo? | 7 → 3 | 0.85–0.87 | 0.89–0.91 |
| How many moons does Saturn have? | 8 → 4 | 0.98 | 0.98 |
| Speed of light in a vacuum? | 8 → 4 | 0.15–0.16 | 0.11–0.12 |
| When was the Eiffel Tower completed? | 7 → 4 | 0.20–0.27 | 0.21–0.29 |

**Every query falls on the same side of the threshold either way**, so the flag
is correct in both forms. The wording is holding: the four Everest pages in the
Fuji set state large, unrelated numbers, and if they were being read as answers
the score would rise. It falls instead — irrelevant results *dilute* the signal
toward agreement.

That is the safe direction (a missed flag, never a false alarm), and it is why
the shipped threshold is 0.5 rather than something higher: Fuji clears it by
0.15 in the diluted form.

A second request over the survivors alone would buy roughly 0.2 of extra margin
for about +1,800 input tokens (+37%), an extra 150–200 ms and a second failure
mode. It changes no flag on this set, so it was not built. If the flag is ever
observed to miss a disagreement in practice, that is the first thing to try.

---

## 3. What to actually do

### Do — dedupe in code, before the gate call

Run it *before* the Jev request so duplicates don't consume gate tokens either.
No network, no key, deterministic, unit-testable offline.

1. Canonicalise URLs: drop `#fragment`, strip `utm_*`/`sc_lid`/`fbclid`/`ref`,
   strip trailing `/print(.html)`, `/amp`, `/index.html`, trailing slash, leading
   `www.`. Identical canonical URL → drop the later one.
2. 5-gram shingle **containment** of the shorter text in the longer ≥ **0.8** →
   drop the later one. (Containment, not Jaccard: it survives truncation and
   superset pages.)
3. Keep original result order; the gate ranks afterwards.

### Do — one set-level agreement `noul` in the existing gate request

- Append it to `buildGateRequest`; no second request, no new failure mode.
- Threshold **0.5**, calibrated on the composed pipeline (§2.3) — not 0.7.
- Skip the question when fewer than 2 results reach the gate.
- Above threshold, **annotate, never drop.**
- Expose as `gate.flagDisagreement?: boolean | number` (default on with the gate).
- Fails open with the rest of the gate: no answer → no annotation.

**Annotation channel (verified against the installed types).** A websearch
provider's `execute` must return exactly
`{ url: string; time: { published?: number }; title?: string; content?: string }`
— there is no metadata slot, so the note cannot ride on the results themselves
without either inventing a fake source or misattributing the note to a real one.
The clean channel is a separate hook the plugin already has access to:

```ts
ctx.tool.hook("execute.after", async (event) => {
  if (event.tool !== "websearch" || event.status !== "completed") return
  const note = takePendingNote(event.input.query)   // set during provider execute
  if (note) event.result = { ...event.result, content: [{ type: "text", text: note }, ...event.result.content] }
})
```

**Verified at runtime against opencode v2.0.10, and the types are misleading
here.** `event.result.output` is typed `any` and the docs imply a string; it is
actually a structured object (`{provider, results[]}`) that the model never
reads. The model-visible text is `event.result.content`, an array of
`{type: "text", text}` blocks. A probe plugin that prepended a marker block to
`content` had the marker read back verbatim by the model; the same probe
guarded on `typeof output === "string"` never fired. Anything written to
`output` would have been a silent no-op.

`event` carries `tool`, `status`, `sessionID`, `messageID` and
`input` (`{query}`). A websearch provider's `execute` receives only `{query}` —
no session id — so the query is the join key between the two.

**Note wording.** Two of the four positives are *definitional* rather than
erroneous — Tokyo (city / urban / metro) and Tesla (new / used / trim) are
underspecified questions, not cases where a source is wrong. Wording that
implies error would train the agent to hedge on answerable questions. Use
something that covers both:

> Note: these sources give different values for this question. They may be
> measuring different things, or one may be wrong — compare them before
> answering.

### Don't

- **Don't add a Jev dedupe pass.** 2 false drops in 5; its failure mode deletes
  corroborating evidence, which is unrecoverable downstream.
- **Don't gate anything on `confidence`.** Anti-correlated with truth here.
- **Don't add pairwise questions of any kind.** O(n²) for a signal the O(1)
  question measures better.
- **Don't drop results for disagreeing.** The `citation_check` precedent
  surfaces contradictions as a verdict; so should this.

### Sequencing

1. Commit the verified v1 as-is (nothing in this repo is committed yet).
2. Local dedupe + tests as commit 2 — no API surface change, no cost.
3. Agreement annotation + tests as commit 3.
4. Rotate the LangSearch key (still outstanding from the handoff).

### What would change this answer

The Jev dedupe pass becomes worth its call if paraphrase duplicates show up in
real traffic. They did not appear in 33 pairs across 6 queries. Re-test on a
domain-restricted or news-heavy corpus, where syndicated rewrites are common,
before reopening it — and if reopened, evaluate it *as a tie-breaker above the
containment check*, not as a replacement for it.

The agreement threshold is calibrated on 6 queries, 4 of them disagreeing. Fuji
sits closest to the boundary. Widening the query set is the first thing to do if
the flag starts firing on agreeing results.

---

## 4. What shipped

Both recommendations, and nothing else. `src/index.ts`, `test/plugin.test.ts`
and `README.md`; 74 tests passing, typecheck and build clean.

| | |
|---|---|
| `dedupe` (default on) | `canonicalizeUrl` + 5-gram `containment` ≥ 0.8, applied before the gate call. Local, no key, no network. |
| `gate.flagDisagreement` (default on with the gate) | one `noul` in the request the gate already sends; threshold 0.5; annotates, never drops. |
| Not built | the Jev dedupe pass, any pairwise question, any confidence gate, any second request. |

**The annotation channel was wrong in the first draft of this document.** The
types say `event.result.output` is `any` and the OpenCode docs show a string;
at runtime it is a structured object the model never reads. A probe plugin that
prepended a marker to `output` was a silent no-op; the same probe writing to
`event.result.content` had its marker read back verbatim by the model. The
implementation writes to `content`.

Verified against the installed bundle, live, end to end:

| Query | raw → dedupe → gate | gate input tokens | disagreement | note |
|---|---|---|---|---|
| How tall is Mount Fuji? | 8 → 7 → 3 | 4,827 (was 5,222) | 0.71 | attached |
| What is the population of Tokyo? | 8 → 7 → 3 | 4,093 | 0.87 | attached |
| What is the speed of light in a vacuum? | 8 → 8 → 4 | 4,882 | 0.17 | none |

Driving a real OpenCode session, the model read the note back as the first line
of the Mount Fuji tool output, and read a normal search result as the first line
of the speed-of-light one.

Deduplicating before the gate also **lowered** gate cost by 7.6% on Fuji, so the
two changes together cost less per search than the gate did on its own for any
query carrying a duplicate.

---

## 5. Second round: what the Jev ecosystem was already doing

Jev shipped 2026-09-15. Surveying what had been built with it in the first five
days (the `awesome-jev` list, ~200 projects) changed the answer twice.

**It corroborated the dedupe call.** `Jev Search` ranks Search1API results with
Noul judgments but merges duplicate URLs *in application code* — independently
the same split this project arrived at: Jev for judgment, plain code for
identity.

**It showed the biggest win had been left on the table.** Passage- and
element-level filtering is the ecosystem's most common high-value pattern —
`jev-pruner` (trims long tool output for Claude Code), `LlamaIndex Jev` (scores
retrieved passages, nDCG@5 0.340 → 0.396 at $0.0003/query), `unclutter` and
`typesafe-adblock` (per-DOM-element keep/drop), `Sniff Test` (ten Booleans per
paragraph at 0.7). The gate was filtering whole results while returning every
page in full.

**A counter-example kept it honest.** "Jev reranking is not a free win" (33,047
entries, 164 queries, 9,831 pairs) found Jev reranking alone did not beat vector
retrieval. Filtering irrelevant results is not the same claim as reranking, and
this project only makes the former.

### 5.1 Passage trimming, measured

330 passages from 14 live queries, `noul` and `score` primitives, three
thresholds each:

| primitive | threshold | text cut | answer recall |
|---|---|---|---|
| noul | 0.3 | 37% | 14/14 |
| **noul** | **0.5** | **42%** | **14/14** |
| noul | 0.7 | 48% | 14/14 |
| score | 0.5 | 16% | 14/14 |
| score | 1.0 | 40% | 14/14 |
| score | 1.5 | 50% | 14/14 |

`noul` and `score` perform the same; `noul` matches the primitive the gate
already uses, so it was chosen. Recall is 14/14 at every threshold, so the
threshold was picked on **margin** instead: across six queries the best
answer-bearing passage scored ≥ 0.99, leaving ~0.49 of headroom at 0.5.

Cost: 3,367 input tokens and ~152 ms per search ($0.00014).

### 5.2 A duplicate the shipped filter missed

Diagnosing a lost answer exposed a real gap rather than a trimming failure: for
"How do I reverse a string in Python?", LangSearch returned **five copies of the
same 26-character stub**, each on its own URL. All five survived — the bodies sat
below the 10-shingle floor, so the content check never ran. Byte-identical
bodies are now duplicates at any length. Live re-check: 8 → 4.

### 5.3 End-to-end, shipped

Eight live searches through the installed bundle:

| | raw | delivered | cut |
|---|---|---|---|
| total characters | 77,507 | 15,933 | **79%** |

≈1,900 agent tokens saved per search for ≈$0.0003 of Jev — between 20x and 90x
return depending on the calling model's input price.

Conflicting values survive trimming: Mount Fuji keeps 11,388 and 12,388 ft,
Saturn keeps 63, 83 and 274, Tokyo keeps 14.25M and 39.1M. A passage stating a
disputed figure is answer-bearing, so it scores high.

**One honest caveat.** In a live session, `gemini-3.5-flash-lite` received the
disagreement note (delivery verified separately by having a model echo the first
line of tool output) and still answered "the sources agreed." The note reaches
the model; whether a very small model acts on it is a separate question, and not
one this plugin can settle.

---

## 6. Third round: showing the user what jev did

The gate was working and invisible. Every `console.log` in `setup()` — the key
source, the dedupe drops, the gate's kept/total — went nowhere a user could
read. The question was whether OpenCode offers a channel for that which does not
also feed the model.

### 6.1 The finding that started it

Grepping every file in `~/.local/share/opencode/log/` for the plugin's own
setup lines (`Registered LangSearch`, `Local duplicate filter`,
`API key loaded`) returns **zero hits**. Plugin `console` output is not captured
into OpenCode's log. Every transparency line the plugin emitted was dead code
from the user's point of view.

### 6.2 Tool metadata is invisible to the model — verified on both paths

A tool result is `{output, content, metadata}`. The claim that `metadata` never
reaches the model has two paths to check, not one, and only the first is
obvious.

**The immediate return.** In the host's `Tool.execute`, the `execute.after` hook
is triggered on a mutable result, and what comes back is built from `content`:

```js
let v = {...k, status:"completed", result:{...output, content, ...metadata}}
yield* e.trigger("tool","execute.after", v)
let N = yield* i(Yi(v.result.content, v.result.output))
return {...output, content: N, ...(v.result.metadata !== undefined && {metadata: v.result.metadata})}
```

This also confirms that a hook's mutation of `result.metadata` is persisted —
the mechanism the trace depends on.

**History replay**, which matters more: if metadata leaked when a past search is
rebuilt for the next turn, a debug payload would silently pollute every
subsequent request. Stored tool parts become model messages through:

```js
q9 = (e,n) => { if (e.state.status === "completed") {
  let T = e.state.content, i = T.length===1 ? T[0] : void 0
  return LA.make({ id:e.id, name:e.name,
    result: i?.type==="text" ? {type:"text",value:i.text} : {type:"content",value:T}, ... }) } }
```

Only `state.content` is read; `state.metadata` is never touched. The serializer
then emits `{toolCallId, toolName, output, providerOptions}` and nothing else.

Both extracted from the opencode v2.0.10 binary. **Metadata is a durable,
model-invisible side channel.**

### 6.3 What the stock TUI will and will not show

Metadata being stored is not metadata being displayed. OpenCode's TUI keeps a
per-tool renderer registry; the `websearch` entry is

```js
websearch: { view:{output:false, final:false}, run:U, scroll:{start:Ft} }
U = (t) => ({ icon:"◈", title: t.input.query ? `${wN(t.metadata.provider)} "${t.input.query}"` : ... })
```

`U` reads `metadata.provider` and nothing else, and `view.output:false` means
the body is not rendered either. Glob and Grep emit a `description` line from
their metadata; websearch does not. So a trace on the tool result is stored and
carried to every client, and shown by none of them.

### 6.4 The channel that does show it

Three candidates, in the order they were ruled out:

- **`tui.toast.show`** is a real bus event the TUI subscribes to and renders.
  But it can only be *published* from inside the TUI: the server plugin context
  exposes `event.subscribe` only, and there is no client method or HTTP route
  for it. Not reachable from the search.
- **Plugin RPC** (`rpc.register` + `events.emit`, dispatched at
  `POST /api/rpc/:rpcID/:method`) would bridge server to TUI, at the cost of a
  third entrypoint and a schema kept in sync across two processes.
- **`session.tool.success`** already carries `data.metadata` and is a typed
  entry in the TUI plugin's event map. The server half writes metadata, which it
  wants to do anyway; the TUI half reads the event. No RPC, no shared schema.

A plugin package can expose three entrypoints — `Host.resolve` looks for
`server`/`""`, `tui` and `rpc` — and a package with no `tui` entry is recorded
as `status: "unsupported"` and ignored. So the TUI half is additive: hosts that
do not load it lose the toast and nothing else.

The TUI half is deliberately JSX-free. The TUI compiles plugin sources with a
Solid transform whose filter excludes anything under `node_modules`, so an
installed package cannot rely on it. Toasts, dialogs and keymap commands need no
markup; slots and panels do, which is why there is no sidebar view.

### 6.5 What the trace costs

One live search (`how many moons does saturn have`, 8 results, gate + trim):

| | bytes |
|---|---|
| trace — counts, scores, decisions, questions | 3,816 |
| verbose record — plus the text sent to jev and its raw answers | 30,236 |

An 8× difference, and the trace is attached to a tool result that OpenCode keeps
for the life of the session. Hence the split: the bounded trace on the tool
result, the bodies in a file the user can rotate or delete.

### 6.6 A keymap layer needs a component owner

The first TUI build failed to load:

```text
Plugin: langsearch.tui   Status: failed   Runtime: tui
Error: Keymap.Provider is missing
```

`ctx.keymap.layer()` is not a registration call. It creates a *reactive* layer
owned by the Solid component that calls it, and reads the TUI's Keymap context
to do so. `setup` runs outside the component tree, so the context lookup throws
and the whole plugin fails to load — the toast subscription with it.

The fix is to render a component into the `app` slot and create the layer from
there. It draws nothing and returns `null`:

```ts
const commands = () => {
  ctx.keymap.layer(() => ({ mode: "global", commands: [ ... ] }))
  return null
}
const unmount = ctx.ui.slot({ append: "app", render: () => commands() })
```

`app` is the outermost slot and stays mounted for the session, so the commands
live as long as the plugin does. No JSX is needed: a Solid component is a
function, and returning `null` is a valid element.

Worth recording because the published docs say `keymap.layer()` may be called
"during setup", which is what the first build did. The
[opencodev2-tui-reference](https://github.com/hecateq/opencodev2-tui-reference)
plugin is right where the docs are wrong, and says so in a comment: *"Keymap
layers are reactive and owned by the calling Solid component inside
`<Keymap.Provider>`"*.

`ctx.data.on` and `ctx.ui.toast.show` have no such requirement and are called
from `setup`, as both the docs and that reference do.

### 6.7 What is verified, and what is not

Worth stating precisely, because the two halves are not equally proven.

**Server half — verified live.** Real searches through the built bundle against
both APIs, producing the traces in §6.5 and §6.8.

**TUI half — loading verified live; the toast is not.** A first build loaded and
failed in a real TUI (§6.6), which disproved the earlier claim that structural
checks were enough. The fix is confirmed by the host's own log (below). What is
checked:
the packed tarball resolves `@jamubc/opencode-langsearch/tui` to `dist/tui.js`
and `.../server` returns `ERR_PACKAGE_PATH_NOT_EXPORTED`, which is in the
loader's swallow list, so the server half falls through to `.` as intended; the
module loads standalone with no dependencies and satisfies the host's validity
check (`id` string, `setup` function); every formatter is unit-tested against
real recorded traces. What was **not** checked: an actual OpenCode TUI
delivering a `session.tool.success` event to the handler and painting the toast.
That needs an interactive session with a search in it. The toast remains
inference from the SDK's types, not observation — and §6.6 is the reminder of
what that inference is worth.

**The oracle.** OpenCode records plugin loading in its own log, separately from
anything a plugin prints (`opencode debug paths log`):

```text
message="plugin reconciliation started"   component=plugin id=<n> role=cli
message="plugin reconciliation completed" component=plugin id=<n> plugins=<count>
message="plugin operation failed" component=plugin stage=setup error="<msg>" plugin=<id> target=<path>
```

So a TUI plugin can be pass/failed without a human reading the screen: launch
the TUI, let it settle, quit, then check that the run produced no
`plugin operation failed` line for the plugin. That is how the keymap fix was
confirmed — failures at every launch up to 18:22:51Z, none after the fixed
build was installed at 18:28Z.

Two limits worth recording. Only the full interactive TUI reaches plugin
reconciliation; one-shot subcommands (`plugin list`, `debug *`, `auth list`,
every `--help`) log a single `cli starting` line and never load TUI plugins, so
none of them can be used as the test harness. And `opencode plugin list` reports
server plugins only — `langsearch.tui` never appears there, and the
"Plugin failed / Runtime: tui" panel the user saw is text rendered inside the
TUI, not something any API exposes.

### 6.8 Live

The same search, end to end: 8 found → 4 gated out → 4 returned, 3,753 → 1,556
chars, disagreement 0.98 (flagged), 23 passages scored and 9 kept. Both results
dropped as `over-cap` scored above every threshold (0.93/0.84 and 0.94/0.95) and
lost only the ranking — a distinction the counts alone hide, and the reason the
per-result reason code is recorded rather than a kept/dropped flag.

---

## Reproducing

Scripts are in the session scratchpad: `passages.ts`, `trimeval.ts` and
`margin.ts` (passage trimming, thresholds and answer margin), `pass2.ts`
(pairwise probes), `eval.ts`
(6-query harness), `agg.ts` (set-level agreement, 2-pass), `onepass.ts` (folded
into the gate call), `local.ts` (local heuristics vs Jev), `reconcile.ts`
(paraphrase + disagreement controls), `generalize.ts` (17-decision head-to-head),
`composed.ts` (end-to-end). Both `LANGSEARCH_API_KEY` and `TYPESAFE_API_KEY`
must be set.

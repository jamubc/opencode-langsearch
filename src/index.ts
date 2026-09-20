import { readFileSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { DEFAULT_CHECKS, byPrecedence, checksOf, findEnabledCheck, validateChecks } from "./checks"
import type { Check } from "./checks"

/** Provider id registered with OpenCode's `websearch` domain. */
export const PROVIDER_ID = "langsearch"

/** Display name shown in OpenCode. */
export const PROVIDER_NAME = "LangSearch"

/** LangSearch web search endpoint. */
export const ENDPOINT = "https://api.langsearch.com/v1/web-search"

/** Optional fallback location for the API key. */
export const DEFAULT_KEY_FILE = join(homedir(), ".config", "opencode", "langsearch.key")

/** TypeSafe System One endpoint used by the optional jev gate. */
export const DEFAULT_GATE_ENDPOINT = "https://api.typesafe.ai/v1/systemone"

/** Default gate model. `jev-latest` resolves to TypeSafe's newest release. */
export const DEFAULT_GATE_MODEL = "jev-latest"

/** Optional fallback location for the TypeSafe API key. */
export const DEFAULT_GATE_KEY_FILE = join(homedir(), ".config", "opencode", "typesafe.key")

/**
 * Word n-gram size used when comparing result bodies. Five is long enough that
 * two independent pages on the same subject share almost none, and short enough
 * to survive small editorial differences between copies of the same text.
 */
export const SHINGLE_SIZE = 5

/**
 * Minimum shingles a body needs before it is compared by content at all.
 * A very short snippet carries too little text to judge; those results are
 * deduplicated by URL only.
 */
export const MIN_SHINGLES = 10

/**
 * Default containment above which the later of two results is treated as a
 * redistribution of the earlier one.
 *
 * Measured over 33 result pairs from six live queries: redistributed copies
 * (a print variant, a Wikipedia mirror, a shared boilerplate block) scored
 * 0.873-0.975, and independent pages scored at most 0.030. Any threshold inside
 * that gap behaves identically; 0.8 sits near the middle with margin on both
 * sides. See RESEARCH.md.
 */
export const DEFAULT_MIN_CONTAINMENT = 0.8

/** Observed containment gap, asserted in the tests so the default cannot drift out of it. */
export const OBSERVED_CONTAINMENT_GAP = { distinctMax: 0.03, duplicateMin: 0.873 } as const

/**
 * Default probability above which a passage is kept when trimming.
 *
 * Answer recall was 14/14 at 0.3, 0.5 and 0.7 alike; the conservative end of
 * that range is chosen because missing the answer is the expensive error.
 */
export const DEFAULT_MIN_PASSAGE = 0.5

/** Smallest fragment kept as its own passage; shorter ones join the previous passage. */
export const MIN_PASSAGE_CHARS = 40

/** Upper bounds on the trim request, so a few very long pages cannot blow the 32k state limit. */
export const TRIM_LIMITS = { maxPassages: 120, maxChars: 24_000 } as const

/**
 * Key under which the debug trace is attached to the websearch tool result's
 * `metadata`.
 *
 * `metadata` is not sent to the model. Verified against opencode v2.0.10 on
 * both paths that could carry it: the tool result returned to the agent is
 * built from `content` alone, and history replay rebuilds past tool calls from
 * `state.content` only - `state.metadata` is never read. See RESEARCH.md.
 */
export const TRACE_METADATA_KEY = "langsearch"

export interface LangSearchOptions {
  /** LangSearch API key. Falls back to LANGSEARCH_API_KEY, then the key file. */
  apiKey?: string
  /** Number of results to request (1-50). Defaults to 8. */
  count?: number
  /** `noLimit`, `oneDay`, `oneWeek`, `oneMonth`, `oneYear`, `YYYY-MM-DD`, or `YYYY-MM-DD..YYYY-MM-DD`. */
  freshness?: string
  /** Restrict results to these domains. */
  includeDomains?: string[]
  /** Exclude results from these domains. */
  excludeDomains?: string[]
  /** Request full page text (`true`), snippets (`false`), or a custom character limit. Defaults to `true`. */
  text?: boolean | { maxCharacters?: number }
  /** Make LangSearch the default search provider. Defaults to `true`. */
  setDefault?: boolean
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number
  /** Path to a file containing the API key. Defaults to `~/.config/opencode/langsearch.key`. */
  keyFile?: string
  /**
   * Drop results that are redistributions of an earlier result - a print
   * variant of the same URL, a mirror, or a page sharing a boilerplate block.
   * Runs locally with no network call and no API key, before the gate, so
   * duplicates never reach the gate either.
   *
   * Two independent pages that state the same fact are not duplicates and are
   * both kept: when sources disagree, independent corroboration is the evidence
   * that settles it.
   *
   * On by default. `false` disables it; an object overrides the threshold.
   */
  dedupe?: boolean | DedupeOptions
  /**
   * Record what the plugin did to each search - what jev was asked, how it
   * answered, and which results were kept or dropped and why.
   *
   * Nothing recorded here reaches the model. The trace is attached to the
   * websearch tool result's `metadata`, which opencode stores and shows to the
   * user but never sends to the model, and optionally appended to a file.
   *
   * Off by default. `true` attaches the trace; an object overrides the
   * destinations.
   */
  debug?: boolean | DebugOptions
  /**
   * Optional jev gate. When enabled, LangSearch results are scored by a fast
   * System One model before they are returned: prompt-injection attempts,
   * irrelevant pages and pages without usable evidence are dropped, and the
   * rest are ranked by relevance and capped. Saves tokens for the calling
   * model. Off by default.
   *
   * `true` uses the defaults; an object overrides them.
   */
  gate?: boolean | GateOptions
}

/** Options for the optional jev gate. */
export interface GateOptions {
  /** Gate model or alias (`jev-latest`, `jev-preview`, `jev-1.13.0`). Defaults to `jev-latest`. */
  model?: string
  /** System One endpoint. Defaults to TypeSafe's API. */
  endpoint?: string
  /** TypeSafe API key. Falls back to TYPESAFE_API_KEY, then the key file. */
  apiKey?: string
  /** Path to a file containing the TypeSafe API key. Defaults to `~/.config/opencode/typesafe.key`. */
  keyFile?: string
  /** Maximum results returned after gating (1-50). Defaults to 4. */
  maxResults?: number
  /** Drop results scored below this relevance (0-1). Defaults to 0.45. */
  minRelevance?: number
  /** Drop results scored below this evidence (0-1). Defaults to 0.5. */
  minEvidence?: number
  /** Drop results scored above this injection risk (0-1). Defaults to 0.5. */
  maxInjection?: number
  /** Characters of each result sent to the gate. Defaults to 1500. */
  maxContentChars?: number
  /** Gate request timeout in milliseconds. Defaults to 8000. */
  timeoutMs?: number
  /** Results kept when nothing passes the thresholds (0-50). Defaults to 1. */
  fallbackResults?: number
  /**
   * After the gate picks which results to return, score each passage of those
   * results and drop the ones that do not bear on the query - the navigation,
   * boilerplate and unrelated filler that makes up most of a web page.
   *
   * This is the largest token saving the gate makes: measured across 14 live
   * queries it removes a further 42% of the text the agent receives, with the
   * answer preserved in all 14. Every result keeps at least its best passage,
   * and a failure returns the untrimmed results.
   *
   * Costs one extra request (the passages are not known until the gate has
   * chosen the results): about 3,400 input tokens and 150 ms. On by default
   * with the gate; `false` disables it, a number sets the threshold.
   */
  trimPassages?: boolean | number
  /**
   * The questions jev is asked. Defaults to `DEFAULT_CHECKS` in `checks.ts`,
   * which is where they are meant to be read and edited; this exists so a test
   * can substitute a different list without touching that file.
   */
  checks?: readonly Check[]
}

/** Options for the debug trace. */
export interface DebugOptions {
  /**
   * Attach the trace to the websearch tool result's `metadata`, where the
   * companion TUI plugin reads it and the model does not. Defaults to `true`.
   */
  metadata?: boolean
  /**
   * Append one JSON object per search to this file, newline-delimited.
   * Off unless a path is given.
   *
   * This is the only sink that works with no TUI attached: the plugin's
   * `console` output does not reach opencode's log file, so a headless or
   * scripted run has nowhere else to look.
   */
  file?: string
  /**
   * Include the full text sent to jev and its raw answers in the file records.
   * Large - a single search can run to tens of kilobytes - so it is off by
   * default and never attached to `metadata`, which opencode stores for the
   * life of the session.
   */
  verbose?: boolean
}

/** One jev question, as asked, with the per-result key replaced by a placeholder. */
export interface TracedQuestion {
  instructions: string
  criteria?: { true: string; false: string }
  /** How many questions of this kind were asked in the request. */
  asked: number
}

/** What the gate did, as recorded for the user. */
export interface GateTrace {
  model: string
  endpoint: string
  thresholds: {
    maxResults: number
    /** Absent when the check is disabled in `checks.ts` and was not asked. */
    minRelevance?: number
    /** Absent when the check is disabled in `checks.ts` and was not asked. */
    minEvidence?: number
    /** Absent when the check is disabled in `checks.ts` and was not asked. */
    maxInjection?: number
  }
  /** The questions jev was asked, one entry per kind. */
  questions: Record<string, TracedQuestion>
  /** How jev answered, per result. */
  decisions: GateDecision[]
  disagreement?: number
  durationMs: number
  usage: { inputTokens?: number; outputTokens?: number }
  /** Present when the gate failed and the raw results were returned instead. */
  failed?: string
}

/** What passage trimming did, as recorded for the user. */
export interface TrimTrace {
  threshold: number
  questions: Record<string, TracedQuestion>
  passagesTotal: number
  passagesKept: number
  charsBefore: number
  charsAfter: number
  durationMs: number
  usage: { inputTokens?: number }
  /** Present when trimming failed and the untrimmed results were returned. */
  failed?: string
}

/**
 * Everything the plugin did to one search.
 *
 * Deliberately bounded: counts, scores and the question text, but not the page
 * bodies sent to jev. The bulky material goes to the debug file instead,
 * because `metadata` is persisted with the session for as long as it lives.
 */
export interface SearchTrace {
  query: string
  startedAt: string
  /** Results LangSearch returned, before anything was dropped. */
  found: number
  /** Results returned to the model. */
  returned: number
  searchMs: number
  totalMs: number
  /** The freshness window the model asked for, when it asked for one. */
  freshness?: Freshness
  /**
   * Result count and total body size at each stage boundary, so the trace can
   * show what each stage received and what it passed on.
   */
  stages?: StageSizes
  dedupe?: {
    minContainment: number
    dropped: DedupeDrop[]
  }
  gate?: GateTrace
  trim?: TrimTrace
}

/** Items and characters surviving each stage of the pipeline. */
export interface StageSizes {
  /** Straight from the search API. */
  found: { items: number; chars: number }
  /** After the local duplicate filter, when it ran. */
  deduped?: { items: number; chars: number }
  /** After the gate, when it ran. Passage trimming has not happened yet. */
  gated?: { items: number; chars: number }
  /** What the model actually received. */
  returned: { items: number; chars: number }
}

/** Total characters across a set of results. */
export function totalChars(results: readonly LangSearchResult[]): number {
  return results.reduce((sum, result) => sum + (result.content?.length ?? 0), 0)
}

/** Options for the local duplicate filter. */
export interface DedupeOptions {
  /** Containment above which a result is treated as a copy (0-1). Defaults to 0.8. */
  minContainment?: number
}

/** One result dropped by the local duplicate filter. */
export interface DedupeDrop {
  /** Index in the input array. */
  index: number
  url: string
  /** Index of the result this one duplicates. */
  duplicateOf: number
  /** Which signal matched. */
  reason: "url" | "content"
  /** Containment against the kept result, for `content` drops. */
  containment?: number
}

/** Result of the local duplicate filter. */
export interface DedupeOutcome {
  results: LangSearchResult[]
  dropped: DedupeDrop[]
}

/** A single search result in the shape OpenCode expects. */
export interface LangSearchResult {
  url: string
  title?: string
  content?: string
  time: { published?: number }
}

/** One typed System One question. */
export interface GateQuestion {
  type: "noul"
  instructions: string
  /** Optional per the API: a clear question often needs no gloss. */
  criteria?: { true: string; false: string }
}

/** A System One evaluation request for a set of search results. */
export interface GateRequest {
  model: string
  state: {
    query: string
    results: Record<string, { title: string; url: string; text: string }>
    /** Present only on the trim request, which scores passages rather than results. */
    passages?: Record<string, string>
  }
  questions: Record<string, GateQuestion>
}

/** What the gate decided about one result. */
export interface GateDecision {
  /** Index into the original result array. */
  index: number
  url: string
  title?: string
  /** Probability that the result helps answer the query. */
  relevant: number
  /** Probability that the result states usable evidence. */
  evidence: number
  /** Probability that the result tries to instruct an AI reader. */
  injection: number
  /**
   * Age of the result in whole days at the time of the gate run, when the
   * search API supplied a publication date. Undated results have no age, which
   * is different from being old: they are never dropped as stale.
   */
  ageDays?: number
  /**
   * Every result-scoped check's score, by check id - including the three
   * above. A check added to `checks.ts` reaches the debug trace through here
   * without any other change.
   */
  scores?: Record<string, number>
  kept: boolean
  /**
   * Why the result was kept or dropped. A check added to `checks.ts` drops
   * results under its own id, so this is not a closed set.
   */
  reason: "kept" | "over-cap" | "fallback" | "injection" | "irrelevant" | "no-evidence" | (string & {})
}

/** What trimming removed from one gate run. */
export interface TrimOutcome {
  results: LangSearchResult[]
  passagesTotal: number
  passagesKept: number
  charsBefore: number
  charsAfter: number
  usage: { inputTokens?: number }
  durationMs: number
  /** The request that was sent, kept for the debug trace. Absent when none was. */
  request?: GateRequest
  /** The raw answers, kept for the verbose debug file. */
  answers?: Record<string, SystemOneAnswer>
}

/** Full outcome of one gate run, including per-result decisions. */
export interface GateOutcome {
  results: LangSearchResult[]
  decisions: GateDecision[]
  usage: { inputTokens?: number; outputTokens?: number }
  durationMs: number
  /**
   * Probability that two or more results give materially different values for
   * what was asked. Undefined when the question was not asked (disabled, or
   * fewer than two results).
   */
  disagreement?: number
  /** The request that was sent, kept for the debug trace. Absent when none was. */
  request?: GateRequest
  /** The raw answers, kept for the verbose debug file. */
  answers?: Record<string, SystemOneAnswer>
}

interface LangSearchResponse {
  data?: {
    webPages?: {
      value?: Array<{
        url?: string
        name?: string | null
        snippet?: string | null
        text?: string | null
        datePublished?: string | null
      }>
    }
  }
}

/** One answer from a System One response. */
export interface SystemOneAnswer {
  type?: string
  noul?: number
}

interface SystemOneResponse {
  answers?: Record<string, SystemOneAnswer>
  usage?: { input_tokens?: number; output_tokens?: number }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  return typeof anyFn === "function" ? anyFn([signal, timeout]) : signal
}

/** Describe where a resolved key came from, for setup logs (never the key itself). */
function describeKeySource(
  options: { apiKey?: string } | undefined,
  envVar: string,
  keyFile: string,
): string {
  if (options?.apiKey?.trim()) return "the `apiKey` plugin option"
  if (process.env[envVar]?.trim()) return `the ${envVar} environment variable`
  return `the key file ${keyFile}`
}

/**
 * Resolve the API key from plugin options, the environment, then the key file.
 * Exported for testing.
 */
export function resolveApiKey(
  options?: Pick<LangSearchOptions, "apiKey">,
  env: Record<string, string | undefined> = process.env,
  keyFile: string = DEFAULT_KEY_FILE,
): string {
  const fromOptions = options?.apiKey?.trim()
  if (fromOptions) return fromOptions

  const fromEnv = env.LANGSEARCH_API_KEY?.trim()
  if (fromEnv) return fromEnv

  try {
    return readFileSync(keyFile, "utf8").trim()
  } catch {
    return ""
  }
}

/**
 * Resolve the TypeSafe API key from gate options, the environment, then the
 * key file. Exported for testing.
 */
export function resolveGateApiKey(
  options?: Pick<GateOptions, "apiKey">,
  env: Record<string, string | undefined> = process.env,
  keyFile: string = DEFAULT_GATE_KEY_FILE,
): string {
  const fromOptions = options?.apiKey?.trim()
  if (fromOptions) return fromOptions

  const fromEnv = env.TYPESAFE_API_KEY?.trim()
  if (fromEnv) return fromEnv

  try {
    return readFileSync(keyFile, "utf8").trim()
  } catch {
    return ""
  }
}

/**
 * Prefix each result body with the date it was published.
 *
 * This is the half of the recency fix that works on every query, including the
 * ones the gate judged timeless and the ones where a stale result survived as
 * the fallback: the model can discount a 2018 figure itself, but only if it is
 * told the figure is from 2018. `time.published` is set too, but the host
 * decides what to do with that field and may render nothing, so the date is
 * put where the model is certain to read it. Undated results are unchanged.
 * Exported for testing.
 */
export function withDateline(results: readonly LangSearchResult[]): LangSearchResult[] {
  return results.map((result) => {
    const published = result.time?.published
    if (published === undefined || !Number.isFinite(published)) return result
    const date = new Date(published)
    if (Number.isNaN(date.getTime())) return result
    const stamp = date.toISOString().slice(0, 10)
    const content = result.content ?? ""
    if (content.startsWith(`Published: ${stamp}`)) return result
    return { ...result, content: `Published: ${stamp}\n\n${content}` }
  })
}

/**
 * The freshness windows LangSearch accepts.
 *
 * Verified live against the API: `oneDay` on "price of bitcoin" returns
 * same-day reporting, `noLimit` returns years-old price-history pages. The
 * search engine does this filtering; nothing here re-implements it.
 */
export const FRESHNESS_VALUES = ["noLimit", "oneDay", "oneWeek", "oneMonth", "oneYear"] as const

export type Freshness = (typeof FRESHNESS_VALUES)[number]

/** A freshness value the API accepts, or `undefined` for anything else. */
export function parseFreshness(value: unknown): Freshness | undefined {
  return typeof value === "string" && (FRESHNESS_VALUES as readonly string[]).includes(value)
    ? (value as Freshness)
    : undefined
}

/**
 * The `freshness` property added to the websearch tool so the model can choose
 * the window itself.
 *
 * The model knows whether it is asking for a price or for a definition; a
 * classifier would have to infer that, and inferring the world's rate of
 * change is not something a text classifier can do. Exported for testing.
 */
export const FRESHNESS_PROPERTY = {
  type: "string",
  enum: [...FRESHNESS_VALUES],
  description:
    "How recent the results must be. Use `oneDay` or `oneWeek` for prices, news, scores, " +
    "releases or anything else that changes; `oneMonth` or `oneYear` for evolving topics; " +
    "`noLimit` (the default) for definitions, history and reference material.",
} as const

/**
 * Parse the `datePublished` LangSearch returns into epoch milliseconds.
 *
 * The field is typed `string | null` and is not always filled, so anything that
 * does not parse becomes `undefined` - an undated result, never a very old one.
 * Every caller must treat "no date" and "old" as different: dropping a result
 * for a date the API never sent would discard good sources.
 * Exported for testing.
 */
export function parsePublished(value: string | null | undefined): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Run a LangSearch query and map the response into OpenCode websearch results.
 * Exported for testing.
 */
export async function searchLangSearch(
  query: string,
  options: LangSearchOptions & { apiKey: string },
  signal?: AbortSignal,
  freshness?: Freshness,
): Promise<LangSearchResult[]> {
  const body: Record<string, unknown> = {
    query,
    count: clamp(options.count ?? 8, 1, 50),
    freshness: freshness ?? options.freshness ?? "noLimit",
  }

  if (options.includeDomains?.length) body.includeDomains = options.includeDomains
  if (options.excludeDomains?.length) body.excludeDomains = options.excludeDomains

  const text = options.text ?? true
  if (text === true) {
    body.contents = { text: true }
  } else if (text !== false) {
    body.contents = { text: { maxCharacters: text.maxCharacters ?? 5000 } }
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: combineSignals(signal, options.timeoutMs ?? 30_000),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    const suffix = detail ? ` ${detail.slice(0, 500)}` : ""
    throw new Error(`LangSearch request failed: HTTP ${response.status}${suffix}`)
  }

  const json = (await response.json()) as LangSearchResponse
  const items = json?.data?.webPages?.value ?? []

  return items
    .filter((item): item is { url: string } & typeof item => typeof item.url === "string" && item.url.length > 0)
    .map((item) => {
      const published = parsePublished(item.datePublished)
      return {
        url: item.url,
        title: item.name ?? item.url,
        content: item.text ?? item.snippet ?? "",
        time: published === undefined ? {} : { published },
      }
    })
}

/**
 * Normalize the `debug` option, or `undefined` when disabled.
 *
 * `true` means the default destination - the tool result metadata - and not
 * the file, which needs a path. An object that turns metadata off and names no
 * file records nothing, and is treated as disabled so the trace is never built.
 * Exported for testing.
 */
export function normalizeDebugOption(debug: LangSearchOptions["debug"]): DebugOptions | undefined {
  if (!debug) return undefined
  const options = debug === true ? {} : debug
  const metadata = options.metadata !== false
  const file = resolveDebugFile(options.file)
  if (!metadata && !file) return undefined
  return { metadata, ...(file ? { file } : {}), verbose: options.verbose === true }
}

/**
 * Expand a leading `~` in the debug file path.
 *
 * A path in a config file is written the way a shell would take it, but nothing
 * expands it on the way here, so `~/traces.jsonl` would otherwise create a
 * directory called `~` beside the config. Exported for testing.
 */
export function resolveDebugFile(file: string | undefined): string | undefined {
  const trimmed = file?.trim()
  if (!trimmed) return undefined
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2))
  return trimmed
}

/**
 * Summarize the questions in a request: one entry per kind, with the
 * per-result key replaced by a placeholder and a count of how many were asked.
 *
 * The questions are what jev was asked, so they belong in the trace; they are
 * also near-identical across results, so recording each one would be noise.
 * Exported for testing.
 */
export function describeQuestions(questions: Record<string, GateQuestion>): Record<string, TracedQuestion> {
  const described: Record<string, TracedQuestion> = {}
  for (const [name, question] of Object.entries(questions)) {
    // `relevant_3` and `passage_r1p7` are both one kind asked many times.
    const kind = name.replace(/_.*$/, "")
    const existing = described[kind]
    if (existing) {
      existing.asked++
      continue
    }
    described[kind] = {
      instructions: question.instructions.replace(/`(results|passages)\.[^`]+`/g, "`$1.<key>`"),
      ...(question.criteria ? { criteria: { ...question.criteria } } : {}),
      asked: 1,
    }
  }
  return described
}

/** Normalize the `dedupe` option into dedupe options, or `undefined` when disabled. */
export function normalizeDedupeOption(dedupe: LangSearchOptions["dedupe"]): DedupeOptions | undefined {
  if (dedupe === undefined || dedupe === true) return {}
  if (!dedupe) return undefined
  return dedupe
}

/**
 * Reduce a URL to the page it identifies, so that print variants, AMP copies,
 * tracking links and trailing-slash differences collapse onto one key.
 * Exported for testing.
 */
export function canonicalizeUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url.trim().toLowerCase()
  }

  parsed.hash = ""
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|sc_lid$|ref$|fbclid$|gclid$|mc_cid$|mc_eid$|igshid$|source$)/i.test(key)) {
      parsed.searchParams.delete(key)
    }
  }
  parsed.searchParams.sort()

  const path = parsed.pathname
    .replace(/\/(?:print|amp)(?:\.html?)?$/i, "")
    .replace(/\/index\.html?$/i, "")
    .replace(/\/+$/, "")

  const host = parsed.hostname.replace(/^www\./i, "")
  return `${host}${path}${parsed.search}`.toLowerCase()
}

/** Word shingles of `text`. Exported for testing. */
export function shingles(text: string, size: number = SHINGLE_SIZE): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(" "))
  return out
}

/**
 * Fraction of the smaller shingle set contained in the larger. Containment
 * rather than Jaccard: a copy is still a copy when one side is truncated or
 * carries extra navigation text. Exported for testing.
 */
export function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const shingle of smaller) if (larger.has(shingle)) shared++
  return shared / smaller.size
}

/**
 * Drop results that redistribute an earlier result's text. Pure and local: no
 * network, no API key. The first occurrence always wins, so the provider's own
 * ordering is preserved. Exported for testing.
 */
export function dedupeResults(
  results: readonly LangSearchResult[],
  options: DedupeOptions = {},
): DedupeOutcome {
  const minContainment = clamp01(options.minContainment ?? DEFAULT_MIN_CONTAINMENT, DEFAULT_MIN_CONTAINMENT)
  const kept: LangSearchResult[] = []
  const dropped: DedupeDrop[] = []
  const keptIndexes: number[] = []
  const keptShingles: Set<string>[] = []
  const seenUrls = new Map<string, number>()
  const seenText = new Map<string, number>()

  results.forEach((result, index) => {
    const canonical = canonicalizeUrl(result.url)
    const sameUrl = seenUrls.get(canonical)
    if (sameUrl !== undefined) {
      dropped.push({ index, url: result.url, duplicateOf: sameUrl, reason: "url" })
      return
    }

    // Byte-identical bodies are duplicates at any length. Without this, a set of
    // short stub pages (observed live: five copies of a 26-character blog page,
    // each on its own URL) is below the shingle floor and survives intact.
    const normalized = (result.content ?? "").toLowerCase().replace(/\s+/g, " ").trim()
    if (normalized) {
      const sameText = seenText.get(normalized)
      if (sameText !== undefined) {
        dropped.push({ index, url: result.url, duplicateOf: sameText, reason: "content", containment: 1 })
        return
      }
    }

    const own = shingles(result.content ?? "")
    if (own.size >= MIN_SHINGLES) {
      for (let slot = 0; slot < keptShingles.length; slot++) {
        const other = keptShingles[slot]!
        if (Math.min(own.size, other.size) < MIN_SHINGLES) continue
        const score = containment(own, other)
        if (score >= minContainment) {
          dropped.push({
            index,
            url: result.url,
            duplicateOf: keptIndexes[slot]!,
            reason: "content",
            containment: score,
          })
          return
        }
      }
    }

    seenUrls.set(canonical, index)
    if (normalized) seenText.set(normalized, index)
    kept.push(result)
    keptIndexes.push(index)
    keptShingles.push(own)
  })

  return { results: kept, dropped }
}

/** Normalize the `gate` option into gate options, or `undefined` when disabled. */
export function normalizeGateOption(gate: LangSearchOptions["gate"]): GateOptions | undefined {
  if (gate === true) return {}
  if (!gate) return undefined
  return gate
}

/** Whole days between a publication time and now, or `undefined` when undated. */
export function ageInDays(published: number | undefined, now: number): number | undefined {
  if (published === undefined || !Number.isFinite(published)) return undefined
  return Math.floor((now - published) / 86_400_000)
}


/**
 * Resolve the gate's cut-offs from its options.
 *
 * One place, so the thresholds the gate applies and the thresholds the debug
 * trace reports cannot drift apart. Exported for testing.
 */
/**
 * The reason names the three original checks drop under.
 *
 * They predate `checks.ts` and are named in the README, the tests and the
 * trace, so they are kept rather than renamed to match their check ids. A
 * check added later drops under its own id.
 */
export const CHECK_REASONS: Record<string, string> = {
  relevant: "irrelevant",
  evidence: "no-evidence",
  injection: "injection",
}

/**
 * The score range a result must fall in to pass one check.
 *
 * The bounds come from `checks.ts`; the three original checks can also be
 * overridden from plugin options, and those win so existing configs behave
 * exactly as before. Exported for testing.
 */
export function resolveCheckBounds(
  check: Check | undefined,
  options: GateOptions = {},
): { min?: number; max?: number } | undefined {
  if (!check || check.scope !== "result") return undefined
  const override =
    check.id === "relevant"
      ? { min: options.minRelevance }
      : check.id === "evidence"
        ? { min: options.minEvidence }
        : check.id === "injection"
          ? { max: options.maxInjection }
          : {}
  const min = override.min ?? check.keep?.min
  const max = override.max ?? check.keep?.max
  if (min === undefined && max === undefined) return undefined
  return {
    ...(min === undefined ? {} : { min: clamp01(min, check.keep?.min ?? 0) }),
    ...(max === undefined ? {} : { max: clamp01(max, check.keep?.max ?? 1) }),
  }
}

export function resolveGateThresholds(options: GateOptions = {}): GateTrace["thresholds"] {
  const checks = options.checks ?? DEFAULT_CHECKS
  // Read back through the same resolver the gate uses, so editing a bound in
  // `checks.ts` changes what the debug trace reports it applied.
  // A disabled check is not asked, so reporting a threshold for it would
  // describe a filter that did not run.
  const bound = (id: string, edge: "min" | "max"): number | undefined =>
    resolveCheckBounds(findEnabledCheck(id, checks), options)?.[edge]
  const relevance = bound("relevant", "min")
  const evidence = bound("evidence", "min")
  const injection = bound("injection", "max")
  return {
    maxResults: clamp(options.maxResults ?? 4, 1, 50),
    ...(relevance === undefined ? {} : { minRelevance: relevance }),
    ...(evidence === undefined ? {} : { minEvidence: evidence }),
    ...(injection === undefined ? {} : { maxInjection: injection }),
  }
}

/**
 * Build the System One request that scores each result for relevance,
 * usable evidence, and prompt-injection risk. Exported for testing.
 */
export function buildGateRequest(
  query: string,
  results: readonly LangSearchResult[],
  options: GateOptions = {},
): GateRequest {
  const maxContentChars = clamp(options.maxContentChars ?? 1500, 200, 20_000)
  const stateResults: GateRequest["state"]["results"] = {}
  const questions: Record<string, GateQuestion> = {}
  const checks = options.checks ?? DEFAULT_CHECKS

  // Question names are `<kind>_<key>`. `describeQuestions` splits on the first
  // underscore to group them for the debug trace, so a kind must not contain
  // one: `no_evidence_0` would be reported as the kind `no`. `validateChecks`
  // enforces that for every id here.
  const resultChecks = checksOf("result", checks)
  results.forEach((result, index) => {
    const key = `r${index}`
    stateResults[key] = {
      title: result.title ?? result.url,
      url: result.url,
      text: (result.content ?? "").slice(0, maxContentChars),
    }
    for (const check of resultChecks) {
      questions[`${check.id}_${index}`] = {
        type: "noul",
        instructions: check.instructions.replace(/<key>/g, key),
        ...(check.criteria ? { criteria: { ...check.criteria } } : {}),
      }
    }
  })

  // The query-scoped checks. Each costs one question in a request that is
  // already being sent, and the answers are independent, so neither moves the
  // per-result scores. What each score is then used for lives in `runGate` -
  // see the note at the top of `checks.ts`.
  for (const check of checksOf("query", checks)) {
    // A single result cannot disagree with anything.
    if (check.id === "agreement") {
      if (results.length < 2) continue
    }
    questions[check.id] = {
      type: "noul",
      instructions: check.instructions,
      ...(check.criteria ? { criteria: { ...check.criteria } } : {}),
    }
  }

  return {
    model: options.model?.trim() || DEFAULT_GATE_MODEL,
    state: { query, results: stateResults },
    questions,
  }
}

/**
 * Score results with a System One model and select the ones worth returning.
 * Throws when the gate request fails; callers decide how to fall back.
 * Exported for testing.
 */
export async function runGate(
  query: string,
  results: readonly LangSearchResult[],
  options: GateOptions = {},
  signal?: AbortSignal,
): Promise<GateOutcome> {
  const started = Date.now()
  if (results.length === 0) {
    return { results: [], decisions: [], usage: {}, durationMs: 0 }
  }

  const request = buildGateRequest(query, results, options)
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const apiKey = options.apiKey?.trim()
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await fetch(options.endpoint?.trim() || DEFAULT_GATE_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal: combineSignals(signal, clamp(options.timeoutMs ?? 8000, 500, 120_000)),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    const suffix = detail ? ` ${detail.slice(0, 500)}` : ""
    throw new Error(`jev gate request failed: HTTP ${response.status}${suffix}`)
  }

  const json = (await response.json()) as SystemOneResponse
  const score = (name: string): number => {
    const value = json?.answers?.[name]?.noul
    return typeof value === "number" && Number.isFinite(value) ? value : 0
  }


  const resultChecks = checksOf("result", options.checks ?? DEFAULT_CHECKS)
  const decisions: GateDecision[] = results.map((result, index) => {
    const ageDays = ageInDays(result.time?.published, started)
    const scores: Record<string, number> = {}
    for (const check of resultChecks) scores[check.id] = score(`${check.id}_${index}`)
    return {
      index,
      url: result.url,
      title: result.title,
      // The three original checks keep their own fields: the trace, the TUI
      // and the option overrides all name them. Every check, including these,
      // also lands in `scores`, which is what a check added to `checks.ts`
      // reaches the trace through.
      relevant: scores.relevant ?? 0,
      evidence: scores.evidence ?? 0, // absent unless a check with this id is enabled
      injection: scores.injection ?? 0,
      scores,
      ...(ageDays === undefined ? {} : { ageDays }),
      kept: false,
      reason: "irrelevant" as string,
    }
  })

  const { maxResults } = resolveGateThresholds(options)

  // A check fails when its score falls outside `keep`. The three original
  // checks can also be overridden from plugin options, which win over the
  // bounds in `checks.ts` so existing configs keep working.
  const orderedChecks = byPrecedence(resultChecks)
  const failedCheck = (decision: GateDecision): Check | undefined =>
    orderedChecks.find((check) => {
      const bounds = resolveCheckBounds(check, options)
      if (!bounds) return false
      const value = decision.scores?.[check.id] ?? 0
      if (bounds.min !== undefined && value < bounds.min) return true
      if (bounds.max !== undefined && value > bounds.max) return true
      return false
    })

  for (const decision of decisions) {
    const failed = failedCheck(decision)
    if (failed) decision.reason = CHECK_REASONS[failed.id] ?? failed.id
  }

  const ranked = decisions
    .slice()
    .sort((a, b) => b.relevant - a.relevant || b.evidence - a.evidence)
  const passing = ranked.filter((decision) => !failedCheck(decision))

  const kept = passing.slice(0, maxResults)
  for (const decision of passing) {
    if (!kept.includes(decision)) decision.reason = "over-cap"
  }

  if (kept.length === 0) {
    const fallbackCount = clamp(options.fallbackResults ?? 1, 0, decisions.length)
    // A result that tries to steer the reader is never returned, not even to
    // avoid returning nothing.
    const injectionBounds = resolveCheckBounds(findEnabledCheck("injection", options.checks ?? DEFAULT_CHECKS), options)
    const safe = ranked.filter(
      (decision) => injectionBounds?.max === undefined || (decision.scores?.injection ?? 0) <= injectionBounds.max,
    )
    for (const decision of safe.slice(0, fallbackCount)) {
      decision.kept = true
      decision.reason = "fallback"
      kept.push(decision)
    }
  }

  const keptResults: LangSearchResult[] = []
  for (const decision of kept) {
    decision.kept = true
    if (decision.reason !== "fallback") decision.reason = "kept"
    const result = results[decision.index]
    if (result) keptResults.push(result)
  }

  return {
    results: keptResults,
    decisions,
    usage: {
      inputTokens: json?.usage?.input_tokens,
      outputTokens: json?.usage?.output_tokens,
    },
    durationMs: Date.now() - started,
    request,
    answers: json?.answers,
  }
}

/**
 * Split a result body into passages. Fragments shorter than `minChars` join the
 * passage before them, so a stray heading or byline never becomes its own
 * scored unit. Exported for testing.
 */
export function splitPassages(text: string, minChars: number = MIN_PASSAGE_CHARS): string[] {
  const parts = text.split(/\n+/).map((part) => part.trim()).filter(Boolean)
  const passages: string[] = []
  for (const part of parts) {
    if (passages.length > 0 && part.length < minChars) passages[passages.length - 1] += `\n${part}`
    else passages.push(part)
  }
  return passages
}

/** Resolve `trimPassages` into a threshold, or `undefined` when disabled. Exported for testing. */
export function resolveTrimThreshold(trimPassages: GateOptions["trimPassages"]): number | undefined {
  if (trimPassages === false) return undefined
  if (typeof trimPassages === "number") {
    return Number.isFinite(trimPassages) ? clamp01(trimPassages, DEFAULT_MIN_PASSAGE) : DEFAULT_MIN_PASSAGE
  }
  return DEFAULT_MIN_PASSAGE
}

/**
 * Build the System One request that scores every passage of the kept results.
 * Bounded by `TRIM_LIMITS` so a handful of very long pages cannot approach the
 * model's state limit. Exported for testing.
 */
export function buildTrimRequest(
  query: string,
  results: readonly LangSearchResult[],
  options: GateOptions = {},
): { request: GateRequest; index: Array<{ key: string; result: number; text: string }> } {
  const state: GateRequest["state"] = { query, results: {}, passages: {} }
  const questions: Record<string, GateQuestion> = {}
  const index: Array<{ key: string; result: number; text: string }> = []
  let chars = 0

  results.forEach((result, resultIndex) => {
    for (const text of splitPassages(result.content ?? "")) {
      if (index.length >= TRIM_LIMITS.maxPassages || chars + text.length > TRIM_LIMITS.maxChars) return
      const key = `r${resultIndex}p${index.length}`
      state.passages![key] = text
      chars += text.length
      questions[`passage_${key}`] = {
        type: "noul",
        instructions: `Does \`passages.${key}\` state information that helps answer \`query\`?`,
        criteria: {
          true: "It states a fact, figure or detail that bears on the query",
          false: "It is about something else, or is navigation, boilerplate or filler",
        },
      }
      index.push({ key, result: resultIndex, text })
    }
  })

  return {
    request: { model: options.model?.trim() || DEFAULT_GATE_MODEL, state, questions },
    index,
  }
}

/**
 * Score the passages of already-selected results and keep only the ones that
 * bear on the query. Every result keeps at least its best-scoring passage, so a
 * result is never returned empty. Throws on request failure; callers fall back.
 * Exported for testing.
 */
export async function trimResults(
  query: string,
  results: readonly LangSearchResult[],
  options: GateOptions = {},
  signal?: AbortSignal,
): Promise<TrimOutcome> {
  const started = Date.now()
  const charsBefore = results.reduce((total, result) => total + (result.content ?? "").length, 0)
  const empty: TrimOutcome = {
    results: [...results],
    passagesTotal: 0,
    passagesKept: 0,
    charsBefore,
    charsAfter: charsBefore,
    usage: {},
    durationMs: 0,
  }

  const { request, index } = buildTrimRequest(query, results, options)
  // Nothing to choose between: a single passage is either the whole answer or
  // all there is, and either way trimming cannot improve it.
  if (index.length < 2) return empty

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const apiKey = options.apiKey?.trim()
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await fetch(options.endpoint?.trim() || DEFAULT_GATE_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal: combineSignals(signal, clamp(options.timeoutMs ?? 8000, 500, 120_000)),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`jev trim request failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 500)}` : ""}`)
  }

  const json = (await response.json()) as SystemOneResponse
  const threshold = resolveTrimThreshold(options.trimPassages) ?? DEFAULT_MIN_PASSAGE
  // A missing answer scores 1: an entry the model did not judge is kept.
  const score = (key: string): number => {
    const value = json?.answers?.[`passage_${key}`]?.noul
    return typeof value === "number" && Number.isFinite(value) ? value : 1
  }

  const keptText = new Map<number, string[]>()
  for (const entry of index) {
    if (score(entry.key) > threshold) {
      const bucket = keptText.get(entry.result) ?? []
      bucket.push(entry.text)
      keptText.set(entry.result, bucket)
    }
  }

  const trimmed = results.map((result, resultIndex) => {
    const own = index.filter((entry) => entry.result === resultIndex)
    // A result whose passages were all cut off by the limits keeps its body.
    if (own.length === 0) return result
    let kept = keptText.get(resultIndex) ?? []
    if (kept.length === 0) {
      const best = own.reduce((a, b) => (score(b.key) > score(a.key) ? b : a))
      kept = [best.text]
    }
    return { ...result, content: kept.join("\n\n") }
  })

  const passagesKept = trimmed.reduce(
    (total, result, resultIndex) =>
      total + (index.some((e) => e.result === resultIndex) ? (keptText.get(resultIndex)?.length || 1) : 0),
    0,
  )

  return {
    results: trimmed,
    passagesTotal: index.length,
    passagesKept,
    charsBefore,
    charsAfter: trimmed.reduce((total, result) => total + (result.content ?? "").length, 0),
    usage: { inputTokens: json?.usage?.input_tokens },
    durationMs: Date.now() - started,
    request,
    answers: json?.answers,
  }
}

/**
 * What one gate run did, filled in as it happens.
 *
 * A plain object rather than more callbacks: the trace is assembled after the
 * search returns, and a failed gate still has something to record.
 */
export interface GateCollector {
  gate?: GateOutcome
  gateError?: string
  trim?: TrimOutcome
  trimError?: string
}

/**
 * Run the gate and never fail the search because of it: on error the raw
 * results are returned. Exported for testing.
 */
export async function gateSearchResults(
  query: string,
  results: readonly LangSearchResult[],
  options: GateOptions = {},
  signal?: AbortSignal,
  collector?: GateCollector,
): Promise<LangSearchResult[]> {
  if (results.length === 0) return []
  try {
    const outcome = await runGate(query, results, options, signal)
    if (collector) collector.gate = outcome
    console.log(
      `[opencode-langsearch] jev gate kept ${outcome.results.length}/${results.length} results` +
        ` in ${outcome.durationMs}ms` +
        (outcome.usage.inputTokens !== undefined ? ` (${outcome.usage.inputTokens} input tokens)` : ""),
    )

    const trimThreshold = resolveTrimThreshold(options.trimPassages)
    if (trimThreshold === undefined || outcome.results.length === 0) return outcome.results
    try {
      const trimmed = await trimResults(query, outcome.results, options, signal)
      if (collector) collector.trim = trimmed
      if (trimmed.passagesTotal > 0) {
        console.log(
          `[opencode-langsearch] jev trim kept ${trimmed.passagesKept}/${trimmed.passagesTotal} passages` +
            ` (${trimmed.charsBefore} -> ${trimmed.charsAfter} chars) in ${trimmed.durationMs}ms` +
            (trimmed.usage.inputTokens !== undefined ? ` (${trimmed.usage.inputTokens} input tokens)` : ""),
        )
      }
      return trimmed.results
    } catch (trimError) {
      if (signal?.aborted) throw trimError
      const detail = trimError instanceof Error ? trimError.message : String(trimError)
      if (collector) collector.trimError = detail
      console.warn(`[opencode-langsearch] jev trim failed, returning untrimmed results: ${detail}`)
      return outcome.results
    }
  } catch (error) {
    if (signal?.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (collector) collector.gateError = message
    console.warn(`[opencode-langsearch] jev gate failed, returning unfiltered results: ${message}`)
    return [...results]
  }
}

/** Everything one search reported about itself, before it is shaped into a trace. */
export interface TraceInput {
  query: string
  /** When the search started, as epoch milliseconds. */
  startedAt: number
  searchMs: number
  totalMs: number
  found: number
  returned: number
  /** The freshness window the model asked for, when it asked for one. */
  freshness?: Freshness
  /** Items and characters at each stage boundary. */
  stages?: StageSizes
  /** Present when the local duplicate filter ran. */
  dedupe?: DedupeOptions
  dropped?: DedupeDrop[]
  /** Present when the gate ran, whether or not it succeeded. */
  gate?: GateOptions
  collector?: GateCollector
}

/**
 * Shape one search into the trace the user sees.
 *
 * Pure, and deliberately lossy: the page bodies sent to jev are left behind,
 * because this trace is attached to the tool result and stored with the
 * session. The verbose material goes to the debug file. Exported for testing.
 */
export function buildTrace(input: TraceInput): SearchTrace {
  const trace: SearchTrace = {
    query: input.query,
    startedAt: new Date(input.startedAt).toISOString(),
    found: input.found,
    returned: input.returned,
    searchMs: input.searchMs,
    totalMs: input.totalMs,
    ...(input.freshness ? { freshness: input.freshness } : {}),
    ...(input.stages ? { stages: input.stages } : {}),
  }

  if (input.dedupe) {
    trace.dedupe = {
      minContainment: clamp01(input.dedupe.minContainment ?? DEFAULT_MIN_CONTAINMENT, DEFAULT_MIN_CONTAINMENT),
      dropped: input.dropped ?? [],
    }
  }

  if (!input.gate) return trace
  const gateOptions = input.gate
  const collector = input.collector ?? {}
  const outcome = collector.gate

  const gate: GateTrace = {
    model: gateOptions.model?.trim() || DEFAULT_GATE_MODEL,
    endpoint: gateOptions.endpoint?.trim() || DEFAULT_GATE_ENDPOINT,
    thresholds: resolveGateThresholds(gateOptions),
    questions: outcome?.request ? describeQuestions(outcome.request.questions) : {},
    decisions: outcome?.decisions ?? [],
    durationMs: outcome?.durationMs ?? 0,
    usage: outcome?.usage ?? {},
  }
  if (collector.gateError) gate.failed = collector.gateError
  trace.gate = gate

  const threshold = resolveTrimThreshold(gateOptions.trimPassages)
  if (threshold === undefined) return trace
  const trimmed = collector.trim
  // Trimming that never ran because the gate failed has nothing to report.
  if (!trimmed && !collector.trimError) return trace

  trace.trim = {
    threshold,
    questions: trimmed?.request ? describeQuestions(trimmed.request.questions) : {},
    passagesTotal: trimmed?.passagesTotal ?? 0,
    passagesKept: trimmed?.passagesKept ?? 0,
    charsBefore: trimmed?.charsBefore ?? 0,
    charsAfter: trimmed?.charsAfter ?? 0,
    durationMs: trimmed?.durationMs ?? 0,
    usage: trimmed?.usage ?? {},
    ...(collector.trimError ? { failed: collector.trimError } : {}),
  }
  return trace
}

/**
 * The verbose record: the trace, plus what was actually sent to jev and what
 * it sent back. Written to the debug file only.
 */
export function buildVerboseRecord(trace: SearchTrace, collector: GateCollector | undefined): Record<string, unknown> {
  const record: Record<string, unknown> = { ...trace }
  if (collector?.gate?.request) record.gateRequest = collector.gate.request
  if (collector?.gate?.answers) record.gateAnswers = collector.gate.answers
  if (collector?.trim?.request) record.trimRequest = collector.trim.request
  if (collector?.trim?.answers) record.trimAnswers = collector.trim.answers
  return record
}

/**
 * Drop every value JSON cannot carry, or `undefined` if the value as a whole
 * cannot be serialized.
 *
 * OpenCode types tool metadata as a record of JSON, so an `undefined` left in
 * a trace would be rejected by the host rather than ignored. This runs inside
 * the tool hook, which the host awaits, so a throw here would fail the search
 * itself - a debug feature must never do that. Exported for testing.
 */
export function toJsonSafe<T>(value: T): T | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return undefined
  }
}

/**
 * Append one newline-delimited JSON record to the debug file.
 *
 * Never throws and never blocks the search: a debug sink that breaks searching
 * would be worse than no debug sink. The first failure is reported once, so a
 * bad path does not produce one warning per search.
 */
export function createTraceFileWriter(path: string) {
  let warned = false
  return async (record: unknown): Promise<void> => {
    try {
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8")
    } catch (error) {
      if (warned) return
      warned = true
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`[opencode-langsearch] could not write the debug file ${path}: ${detail}`)
    }
  }
}

/**
 * Holds a note between the provider's `execute` (which sees the query and the
 * gate result) and the tool hook (which sees the tool output the model reads).
 * A websearch provider's `execute` receives only `{ query }`, so the query is
 * the join key. Bounded, and each note is taken at most once, so a hook that
 * never fires cannot leak entries. Exported for testing.
 */
export function createPendingStore<Value>(limit = 8) {
  const pending = new Map<string, Value>()
  return {
    /** Forget anything pending for `query`, so a stale entry is never delivered. */
    clear(query: string): void {
      pending.delete(query)
    },
    set(query: string, value: Value): void {
      pending.delete(query)
      pending.set(query, value)
      while (pending.size > limit) {
        const oldest = pending.keys().next()
        if (oldest.done) break
        pending.delete(oldest.value)
      }
    },
    take(query: string): Value | undefined {
      const value = pending.get(query)
      if (value !== undefined) pending.delete(query)
      return value
    },
    get size(): number {
      return pending.size
    },
  }
}


/**
 * The debug trace waiting to be attached to a tool result's metadata.
 *
 * Shares the note store's mechanism, and its caveat: a search whose hook never
 * fires leaves one entry behind until the limit evicts it.
 */
export function createTraceStore(limit = 8) {
  return createPendingStore<SearchTrace>(limit)
}


/**
 * Attach `trace` to a tool result's metadata under `TRACE_METADATA_KEY`.
 *
 * Any metadata the host already set (the websearch tool records the provider
 * there, and the TUI renders it) is preserved. Exported for testing.
 */
export function annotateToolMetadata(metadata: unknown, trace: SearchTrace): Record<string, unknown> {
  const existing = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {}
  const safe = toJsonSafe(trace)
  // A trace that cannot be serialized is dropped, not forced onto the result.
  if (safe === undefined) return { ...existing }
  return { ...existing, [TRACE_METADATA_KEY]: safe }
}

export default Plugin.define({
  id: "langsearch.websearch",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as LangSearchOptions
    const apiKey = resolveApiKey(options, process.env, options.keyFile ?? DEFAULT_KEY_FILE)

    if (!apiKey) {
      console.error(
        "[opencode-langsearch] No key found for the LangSearch provider. " +
          "Set `LANGSEARCH_API_KEY` in your global environment, use the `apiKey` plugin option, " +
          `or write the key to ${DEFAULT_KEY_FILE}. The provider was not registered.`,
      )
      return
    }
    console.log(
      `[opencode-langsearch] LangSearch API key loaded from ` +
        `${describeKeySource(options, "LANGSEARCH_API_KEY", options.keyFile ?? DEFAULT_KEY_FILE)}.`,
    )

    let gate = normalizeGateOption(options.gate)
    let gateKeySource = ""
    if (gate) {
      const gateKey = resolveGateApiKey(gate, process.env, gate.keyFile ?? DEFAULT_GATE_KEY_FILE)
      const gateEndpoint = gate.endpoint?.trim() || DEFAULT_GATE_ENDPOINT
      if (!gateKey && gateEndpoint === DEFAULT_GATE_ENDPOINT) {
        console.error(
          "[opencode-langsearch] jev gate is enabled but no TypeSafe API key was found. " +
            "Set `TYPESAFE_API_KEY` in your global environment, use the `gate.apiKey` option, " +
            `or write the key to ${DEFAULT_GATE_KEY_FILE}. The gate was disabled.`,
        )
        gate = undefined
      } else if (gateKey) {
        gateKeySource = describeKeySource(
          gate,
          "TYPESAFE_API_KEY",
          gate.keyFile ?? DEFAULT_GATE_KEY_FILE,
        )
        gate = { ...gate, apiKey: gateKey }
      }
    }

    // Validated here, at plugin load, and not inside the search path: a bad
    // check id thrown during a search would be caught by the gate's fail-open
    // handler and silently return ungated results, which is the opposite of
    // what the validation is for. Throwing here fails the plugin load loudly.
    if (gate) validateChecks(gate.checks ?? DEFAULT_CHECKS)

    const dedupe = normalizeDedupeOption(options.dedupe)
    const debug = normalizeDebugOption(options.debug)
    const traces = createTraceStore()
    // The model's freshness choice, handed from the tool call to the provider.
    // The host gives a search provider only `{ query }` (ProviderInput is
    // `Pick<Input, "query">`), so the parameter cannot arrive any other way.
    const freshnessChoices = createPendingStore<Freshness>()
    const writeTraceFile = debug?.file ? createTraceFileWriter(debug.file) : undefined

    // The trace rides on the tool result's `metadata`, which the model does
    // not read. A host that does not expose the hook still gets gated search;
    // it just gets no trace.
    const wantsHook = debug?.metadata === true
    let canAnnotate = false
    if (wantsHook) {
      if (typeof ctx.tool?.hook === "function") {
        ctx.tool.hook("execute.after", async (event) => {
          if (event.tool !== "websearch" || event.status !== "completed") return
          const query = (event.input as { query?: unknown } | null | undefined)?.query
          if (typeof query !== "string") return
          const trace = debug?.metadata ? traces.take(query) : undefined
          if (!trace) return
          event.result = {
            ...event.result,
            metadata: annotateToolMetadata(event.result.metadata, trace) as typeof event.result.metadata,
          }
        })
        canAnnotate = true
      } else {
        console.warn(
          "[opencode-langsearch] This host does not expose `tool.hook`, so neither the disagreement " +
            "note nor the debug trace can be attached to the search output. Search and gating are " +
            "unaffected, and a debug file, if configured, is still written.",
        )
      }
    }

    // Let the model choose the freshness window. LangSearch filters by date
    // properly - verified live - so the search engine does the filtering and
    // the model, which knows whether it is asking for a price or a definition,
    // does the choosing. Nothing infers it.
    if (typeof ctx.tool?.transform === "function") {
      await ctx.tool.transform((editor) => {
        if (!editor.get?.("websearch")) return
        editor.update("websearch", (tool) => {
          // Replaced rather than widened: the host's schema is an Effect
          // codec, not a plain JSON-schema object, so there are no
          // `properties` to spread. `ValueSchema` accepts a JSON schema
          // directly. `query` is all the host passes a provider anyway
          // (`ProviderInput = Pick<Input, "query">`).
          tool.input = {
            type: "object",
            properties: {
              query: { type: "string", description: "The search query." },
              freshness: { ...FRESHNESS_PROPERTY },
            },
            required: ["query"],
          } as unknown as typeof tool.input
        })
      })
    }
    if (typeof ctx.tool?.hook === "function") {
      ctx.tool.hook("execute.before", async (event) => {
        if (event.tool !== "websearch") return
        const input = event.input as { query?: unknown; freshness?: unknown } | null | undefined
        const query = input?.query
        const freshness = parseFreshness(input?.freshness)
        if (typeof query === "string" && freshness) freshnessChoices.set(query, freshness)
      })
    }

    await ctx.websearch.transform((editor) => {
      editor.add({
        id: PROVIDER_ID,
        name: PROVIDER_NAME,
        execute: async ({ query }, { signal }) => {
          // A trace from an earlier search for the same query whose hook
          // never fired must not be delivered to this one.
          traces.clear(query)

          const freshness = freshnessChoices.take(query)
          const startedAt = Date.now()
          const found = await searchLangSearch(query, { ...options, apiKey }, signal, freshness)
          const searchMs = Date.now() - startedAt

          let results: readonly LangSearchResult[] = found
          let dropped: DedupeDrop[] | undefined
          if (dedupe) {
            const outcome = dedupeResults(found, dedupe)
            dropped = outcome.dropped
            if (outcome.dropped.length > 0) {
              console.log(
                `[opencode-langsearch] dropped ${outcome.dropped.length} duplicate result(s): ` +
                  outcome.dropped
                    .map((drop) => `${drop.url} (${drop.reason} copy of result ${drop.duplicateOf})`)
                    .join(", "),
              )
            }
            results = outcome.results
          }

          // Recorded whatever happens next, so a search the gate never saw is
          // still accounted for.
          const record = (final: readonly LangSearchResult[], collector?: GateCollector): void => {
            if (!debug) return
            const gated = collector?.gate?.results
            const stages: StageSizes = {
              found: { items: found.length, chars: totalChars(found) },
              ...(dedupe ? { deduped: { items: results.length, chars: totalChars(results) } } : {}),
              ...(gated ? { gated: { items: gated.length, chars: totalChars(gated) } } : {}),
              returned: { items: final.length, chars: totalChars(final) },
            }
            const trace = buildTrace({
              query,
              startedAt,
              searchMs,
              totalMs: Date.now() - startedAt,
              found: found.length,
              returned: final.length,
              stages,
              ...(freshness ? { freshness } : {}),
              ...(dedupe ? { dedupe, dropped } : {}),
              ...(gate ? { gate, collector } : {}),
            })
            if (debug.metadata) traces.set(query, trace)
            if (writeTraceFile) {
              void writeTraceFile(debug.verbose ? buildVerboseRecord(trace, collector) : trace)
            }
          }

          if (!gate) {
            record(results)
            return withDateline(results)
          }

          const collector: GateCollector = {}
          const gated = await gateSearchResults(query, results, gate, signal, collector)
          record(gated, collector)
          return withDateline(gated)
        },
      })

      if (options.setDefault !== false) {
        editor.default.set(PROVIDER_ID)
      }
    })

    console.log(
      options.setDefault === false
        ? "[opencode-langsearch] Registered LangSearch web search provider."
        : "[opencode-langsearch] Registered LangSearch web search provider as default.",
    )
    console.log(
      dedupe
        ? `[opencode-langsearch] Local duplicate filter enabled (containment >= ${dedupe.minContainment ?? DEFAULT_MIN_CONTAINMENT}).`
        : "[opencode-langsearch] Local duplicate filter disabled.",
    )
    if (gate) {
      console.log(
        `[opencode-langsearch] jev gate enabled (${gate.model?.trim() || DEFAULT_GATE_MODEL} at ` +
          `${gate.endpoint?.trim() || DEFAULT_GATE_ENDPOINT}` +
          `${gateKeySource ? `; key from ${gateKeySource}` : ""}` +
          `${resolveTrimThreshold(gate.trimPassages) !== undefined ? `; passages trimmed above ${resolveTrimThreshold(gate.trimPassages)}` : ""}).`,
      )
    }
    if (debug) {
      console.log(
        "[opencode-langsearch] Debug trace enabled (" +
          [
            debug.metadata && canAnnotate ? "attached to the tool result" : undefined,
            debug.metadata && !canAnnotate ? "not attached: this host exposes no tool hook" : undefined,
            debug.file ? `${debug.verbose ? "verbose " : ""}records appended to ${debug.file}` : undefined,
          ]
            .filter(Boolean)
            .join("; ") +
          "). Nothing recorded here is sent to the model.",
      )
    }
  },
})

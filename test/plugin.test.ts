import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import plugin, {
  DEFAULT_MIN_PASSAGE,
  TRIM_LIMITS,
  buildTrimRequest,
  resolveTrimThreshold,
  splitPassages,
  trimResults,
  DEFAULT_GATE_ENDPOINT,
  DEFAULT_GATE_MODEL,
  DEFAULT_MIN_CONTAINMENT,
  ENDPOINT,
  MIN_SHINGLES,
  OBSERVED_CONTAINMENT_GAP,
  PROVIDER_ID,
  PROVIDER_NAME,
  TRACE_METADATA_KEY,
  annotateToolMetadata,
  buildGateRequest,
  buildTrace,
  buildVerboseRecord,
  canonicalizeUrl,
  containment,
  createPendingStore,
  createTraceFileWriter,
  createTraceStore,
  dedupeResults,
  describeQuestions,
  gateSearchResults,
  normalizeDebugOption,
  normalizeDedupeOption,
  resolveDebugFile,
  resolveGateThresholds,
  toJsonSafe,
  resolveApiKey,
  resolveGateApiKey,
  runGate,
  searchLangSearch,
  shingles,
  parsePublished,
  ageInDays,
  withDateline,
} from "../src/index"
import type { GateCollector, GateDecision, LangSearchOptions, LangSearchResult, SearchTrace } from "../src/index"
import tuiPlugin, {
  copyToClipboard,
  stageRows,
  renderPipeline,
  dropsByReason,
  shortChars,
  shortMs,
  hostOf,
  shortTitle,
  describeDropped,
  describeScores,
  formatCount,
  formatReduction,
  explainEmpty,
  readTrace,
  renderTrace,
  summarizeTrace,
  toastVariant,
  traceDestination,
  traceView,
  wantsToast,
  formatAge,
  describeScores,
} from "../src/tui"
import type { TuiContext, TuiToastOptions } from "../src/tui"
import { DEFAULT_CHECKS, validateChecks, checksOf, findCheck, byPrecedence } from "../src/checks"
import type { Check } from "../src/checks"
import { formatChecks, formatCheck } from "../src/print-checks"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return calls
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const samplePayload = {
  code: 200,
  data: {
    webPages: {
      value: [
        { url: "https://example.com/a", name: "A", text: "Full text A" },
        { url: "https://example.com/b", name: "B", snippet: "Snippet B" },
        { name: "missing url" },
      ],
    },
  },
}

describe("resolveApiKey", () => {
  test("prefers the plugin option", () => {
    const key = resolveApiKey({ apiKey: "  from-options  " }, { LANGSEARCH_API_KEY: "from-env" })
    expect(key).toBe("from-options")
  })

  test("falls back to the environment", () => {
    expect(resolveApiKey({}, { LANGSEARCH_API_KEY: "from-env" })).toBe("from-env")
  })

  test("falls back to the key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "langsearch-"))
    const file = join(dir, "langsearch.key")
    writeFileSync(file, "from-file\n")
    expect(resolveApiKey({}, {}, file)).toBe("from-file")
  })

  test("returns an empty string when nothing is available", () => {
    expect(resolveApiKey({}, {}, join(tmpdir(), "definitely-missing-key-file"))).toBe("")
  })
})

describe("resolveGateApiKey", () => {
  test("prefers the plugin option", () => {
    const key = resolveGateApiKey({ apiKey: "  from-options  " }, { TYPESAFE_API_KEY: "from-env" })
    expect(key).toBe("from-options")
  })

  test("falls back to the environment", () => {
    expect(resolveGateApiKey({}, { TYPESAFE_API_KEY: "from-env" })).toBe("from-env")
  })

  test("falls back to the key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "typesafe-"))
    const file = join(dir, "typesafe.key")
    writeFileSync(file, "from-file\n")
    expect(resolveGateApiKey({}, {}, file)).toBe("from-file")
  })

  test("returns an empty string when nothing is available", () => {
    expect(resolveGateApiKey({}, {}, join(tmpdir(), "definitely-missing-typesafe-key"))).toBe("")
  })
})

describe("searchLangSearch", () => {
  test("posts the query and maps results", async () => {
    const calls = stubFetch(() => jsonResponse(samplePayload))

    const results = await searchLangSearch("hello world", { apiKey: "k", count: 3 })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(ENDPOINT)
    const body = JSON.parse(String(calls[0]!.init?.body))
    expect(body).toMatchObject({ query: "hello world", count: 3, contents: { text: true } })

    expect(results).toEqual([
      { url: "https://example.com/a", title: "A", content: "Full text A", time: {} },
      { url: "https://example.com/b", title: "B", content: "Snippet B", time: {} },
    ])
  })

  test("clamps count into 1-50", async () => {
    const calls = stubFetch(() => jsonResponse(samplePayload))
    await searchLangSearch("q", { apiKey: "k", count: 999 })
    expect(JSON.parse(String(calls[0]!.init?.body)).count).toBe(50)
  })

  test("omits contents when text is false", async () => {
    const calls = stubFetch(() => jsonResponse(samplePayload))
    await searchLangSearch("q", { apiKey: "k", text: false })
    expect(JSON.parse(String(calls[0]!.init?.body)).contents).toBeUndefined()
  })

  test("throws on a non-ok response", async () => {
    stubFetch(() => new Response("nope", { status: 401 }))
    expect(searchLangSearch("q", { apiKey: "bad" })).rejects.toThrow("HTTP 401")
  })

  test("returns an empty array when there are no results", async () => {
    stubFetch(() => jsonResponse({ data: { webPages: { value: [] } } }))
    expect(await searchLangSearch("q", { apiKey: "k" })).toEqual([])
  })
})

interface AddedProvider {
  id: string
  name: string
  execute: (
    input: { query: string },
    context: { signal: AbortSignal },
  ) => Promise<readonly LangSearchResult[]>
}

interface FakeEditor {
  added: AddedProvider[]
  selected: string | false | undefined
}

type ToolHook = (event: Record<string, unknown>) => Promise<void> | void

function makeContext(options: LangSearchOptions, { withToolHook = true } = {}) {
  const editor: FakeEditor = { added: [], selected: undefined }
  const hooks: Record<string, ToolHook[]> = {}
  const ctx = {
    options,
    ...(withToolHook
      ? {
          tool: {
            hook: (name: string, handler: ToolHook) => {
              ;(hooks[name] ??= []).push(handler)
            },
          },
        }
      : {}),
    websearch: {
      transform: async (callback: (value: typeof editor) => void) => {
        callback({
          add: (provider) => editor.added.push(provider),
          default: {
            get: () => editor.selected,
            set: (value: string | false) => {
              editor.selected = value
            },
          },
        } as unknown as typeof editor)
      },
    },
  }
  /** Drive every registered `execute.after` handler, as the host would. */
  async function fireToolHook(event: Record<string, unknown>) {
    for (const handler of hooks["execute.after"] ?? []) await handler(event)
    return event
  }
  return { ctx, editor, fireToolHook, hooks }
}

describe("plugin setup", () => {
  test("registers the provider and selects it by default", async () => {
    const { ctx, editor } = makeContext({ apiKey: "k" })
    await plugin.setup(ctx as never)

    expect(editor.added).toHaveLength(1)
    expect(editor.added[0]!.id).toBe(PROVIDER_ID)
    expect(editor.added[0]!.name).toBe(PROVIDER_NAME)
    expect(editor.selected).toBe(PROVIDER_ID)
  })

  test("leaves the default untouched when setDefault is false", async () => {
    const { ctx, editor } = makeContext({ apiKey: "k", setDefault: false })
    await plugin.setup(ctx as never)
    expect(editor.added).toHaveLength(1)
    expect(editor.selected).toBeUndefined()
  })

  test("does not register a provider without a key", async () => {
    const { ctx, editor } = makeContext({ keyFile: join(tmpdir(), "langsearch-missing-key") })
    const env = process.env.LANGSEARCH_API_KEY
    delete process.env.LANGSEARCH_API_KEY
    try {
      await plugin.setup(ctx as never)
      expect(editor.added).toHaveLength(0)
    } finally {
      if (env !== undefined) process.env.LANGSEARCH_API_KEY = env
    }
  })
})

function routeFetch(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    calls.push({ url, init })
    const handler = handlers[url]
    if (!handler) throw new Error(`unexpected fetch: ${url}`)
    return handler(init)
  }) as typeof fetch
  return calls
}

function systemOneResponse(answers: Record<string, number>): Response {
  return jsonResponse({
    model: DEFAULT_GATE_MODEL,
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, noul]) => [id, { type: "noul", noul }]),
    ),
    usage: { input_tokens: 10, output_tokens: 2 },
  })
}

function resultSet(): LangSearchResult[] {
  return ["a", "b", "c", "d"].map((id) => ({
    url: `https://example.com/${id}`,
    title: id.toUpperCase(),
    content: `content ${id}`,
    time: {},
  }))
}

describe("buildGateRequest", () => {
  test("asks one typed question per check per result and truncates content", () => {
    const results: LangSearchResult[] = [
      { url: "https://example.com/a", title: "A", content: "x".repeat(500), time: {} },
    ]

    const request = buildGateRequest("how tall is Mount Fuji", results, { maxContentChars: 200 })

    expect(request.model).toBe(DEFAULT_GATE_MODEL)
    expect(request.state.query).toBe("how tall is Mount Fuji")
    expect(request.state.results.r0).toEqual({
      title: "A",
      url: "https://example.com/a",
      text: "x".repeat(200),
    })
    expect(Object.keys(request.questions).sort()).toEqual([
      "injection_0",
      "relevant_0",
    ])
    expect(request.questions.relevant_0!.type).toBe("noul")
    expect(request.questions.relevant_0!.instructions).toContain("results.r0")
  })

  test("uses a custom model", () => {
    const request = buildGateRequest("q", resultSet(), {
      model: "jev-1.13.0",
      endpoint: "https://api.typesafe.ai/v1/systemone",
    })
    expect(request.model).toBe("jev-1.13.0")
    expect(Object.keys(request.state.results)).toEqual(["r0", "r1", "r2", "r3"])
  })
})

describe("runGate", () => {
  test("drops injections and off-topic results", async () => {
    routeFetch({
      [DEFAULT_GATE_ENDPOINT]: () =>
        systemOneResponse({
          relevant_0: 0.9,
          injection_0: 0.02,
          relevant_1: 0.05,
          injection_1: 0.02,
          // On topic, but trying to steer the reader: injection wins over
          // relevance whatever else it scores.
          relevant_2: 0.95,
          injection_2: 0.97,
          relevant_3: 0.85,
          injection_3: 0.02,
        }),
    })

    const outcome = await runGate("q", resultSet(), { maxResults: 4 })

    expect(outcome.results.map((result) => result.url)).toEqual([
      "https://example.com/c".replace("/c", "/a"),
      "https://example.com/d",
    ])
    const reasons = Object.fromEntries(outcome.decisions.map((d) => [d.url, d.reason]))
    expect(reasons["https://example.com/a"]).toBe("kept")
    expect(reasons["https://example.com/b"]).toBe("irrelevant")
    expect(reasons["https://example.com/c"]).toBe("injection")
    expect(reasons["https://example.com/d"]).toBe("kept")
    expect(outcome.usage).toEqual({ inputTokens: 10, outputTokens: 2 })
  })

  test("ranks by relevance and applies the cap", async () => {
    routeFetch({
      [DEFAULT_GATE_ENDPOINT]: () =>
        systemOneResponse({
          relevant_0: 0.7,
          evidence_0: 0.9,
          injection_0: 0,
          relevant_1: 0.9,
          evidence_1: 0.9,
          injection_1: 0,
          relevant_2: 0.8,
          evidence_2: 0.9,
          injection_2: 0,
          relevant_3: 0.1,
          evidence_3: 0.1,
          injection_3: 0,
        }),
    })

    const outcome = await runGate("q", resultSet(), { maxResults: 2 })

    expect(outcome.results.map((result) => result.url)).toEqual([
      "https://example.com/b",
      "https://example.com/c",
    ])
    expect(outcome.decisions.find((d) => d.url.endsWith("/a"))!.reason).toBe("over-cap")
  })

  test("keeps a fallback result when nothing passes", async () => {
    routeFetch({
      [DEFAULT_GATE_ENDPOINT]: () =>
        systemOneResponse({
          relevant_0: 0.2,
          evidence_0: 0.2,
          injection_0: 0,
          relevant_1: 0.3,
          evidence_1: 0.3,
          injection_1: 0,
          relevant_2: 0.1,
          evidence_2: 0.1,
          injection_2: 0,
          relevant_3: 0.05,
          evidence_3: 0.05,
          injection_3: 0,
        }),
    })

    const outcome = await runGate("q", resultSet())
    expect(outcome.results.map((result) => result.url)).toEqual(["https://example.com/b"])
    expect(outcome.decisions.find((d) => d.url.endsWith("/b"))!.reason).toBe("fallback")
  })

  test("never falls back to an injection", async () => {
    routeFetch({
      [DEFAULT_GATE_ENDPOINT]: () =>
        systemOneResponse({
          relevant_0: 0.9,
          evidence_0: 0.9,
          injection_0: 0.98,
          relevant_1: 0.9,
          evidence_1: 0.9,
          injection_1: 0.97,
          relevant_2: 0.9,
          evidence_2: 0.9,
          injection_2: 0.99,
          relevant_3: 0.9,
          evidence_3: 0.9,
          injection_3: 0.95,
        }),
    })

    const outcome = await runGate("q", resultSet())
    expect(outcome.results).toEqual([])
  })

  test("throws on a failed gate response", async () => {
    routeFetch({ [DEFAULT_GATE_ENDPOINT]: () => new Response("nope", { status: 500 }) })
    expect(runGate("q", resultSet())).rejects.toThrow("HTTP 500")
  })
})

describe("gateSearchResults", () => {
  test("returns gated results on success", async () => {
    routeFetch({
      [DEFAULT_GATE_ENDPOINT]: () =>
        systemOneResponse({
          relevant_0: 0.9,
          evidence_0: 0.9,
          injection_0: 0,
          relevant_1: 0.1,
          evidence_1: 0.1,
          injection_1: 0,
          relevant_2: 0.1,
          evidence_2: 0.1,
          injection_2: 0,
          relevant_3: 0.1,
          evidence_3: 0.1,
          injection_3: 0,
        }),
    })

    const results = await gateSearchResults("q", resultSet())
    expect(results.map((result) => result.url)).toEqual(["https://example.com/a"])
  })

  test("returns raw results when the gate request fails", async () => {
    routeFetch({ [DEFAULT_GATE_ENDPOINT]: () => new Response("boom", { status: 503 }) })
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const results = resultSet()
      expect(await gateSearchResults("q", results)).toEqual(results)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("gate integration", () => {
  test("execute gates results when enabled", async () => {
    const { ctx, editor } = makeContext({ apiKey: "k", gate: { maxResults: 1, apiKey: "typesafe" } })
    await plugin.setup(ctx as never)

    const calls = routeFetch({
      [ENDPOINT]: () => jsonResponse(samplePayload),
      [DEFAULT_GATE_ENDPOINT]: () =>
        systemOneResponse({
          relevant_0: 0.9,
          evidence_0: 0.9,
          injection_0: 0.02,
          relevant_1: 0.1,
          evidence_1: 0.1,
          injection_1: 0.02,
        }),
    })

    const results = await editor.added[0]!.execute(
      { query: "mount fuji" },
      { signal: new AbortController().signal },
    )

    expect(calls.map((call) => call.url)).toEqual([ENDPOINT, DEFAULT_GATE_ENDPOINT])
    expect(results.map((result) => result.url)).toEqual(["https://example.com/a"])
  })

  test("execute gates when the key comes from the environment", async () => {
    const env = process.env.TYPESAFE_API_KEY
    process.env.TYPESAFE_API_KEY = "from-env"
    try {
      const { ctx, editor } = makeContext({ apiKey: "k", gate: { maxResults: 1 } })
      await plugin.setup(ctx as never)

      const calls = routeFetch({
        [ENDPOINT]: () => jsonResponse(samplePayload),
        [DEFAULT_GATE_ENDPOINT]: () =>
          systemOneResponse({
            relevant_0: 0.9,
            evidence_0: 0.9,
            injection_0: 0.02,
            relevant_1: 0.1,
            evidence_1: 0.1,
            injection_1: 0.02,
          }),
      })

      const results = await editor.added[0]!.execute(
        { query: "mount fuji" },
        { signal: new AbortController().signal },
      )

      expect(calls.map((call) => call.url)).toEqual([ENDPOINT, DEFAULT_GATE_ENDPOINT])
      const gateCall = calls[1]!
      const headers = gateCall.init?.headers as Record<string, string>
      expect(headers.Authorization).toBe("Bearer from-env")
      expect(results.map((result) => result.url)).toEqual(["https://example.com/a"])
    } finally {
      if (env !== undefined) process.env.TYPESAFE_API_KEY = env
      else delete process.env.TYPESAFE_API_KEY
    }
  })

  test("execute skips the gate when enabled without a TypeSafe key", async () => {
    const env = process.env.TYPESAFE_API_KEY
    delete process.env.TYPESAFE_API_KEY
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      const { ctx, editor } = makeContext({
        apiKey: "k",
        gate: { keyFile: join(tmpdir(), "definitely-missing-typesafe-key") },
      })
      await plugin.setup(ctx as never)

      const calls = routeFetch({ [ENDPOINT]: () => jsonResponse(samplePayload) })
      const results = await editor.added[0]!.execute(
        { query: "q" },
        { signal: new AbortController().signal },
      )

      expect(calls).toHaveLength(1)
      expect(results).toHaveLength(2)
    } finally {
      error.mockRestore()
      if (env !== undefined) process.env.TYPESAFE_API_KEY = env
    }
  })

  test("execute returns raw results when the gate is disabled", async () => {
    const { ctx, editor } = makeContext({ apiKey: "k" })
    await plugin.setup(ctx as never)

    const calls = routeFetch({ [ENDPOINT]: () => jsonResponse(samplePayload) })
    const results = await editor.added[0]!.execute(
      { query: "q" },
      { signal: new AbortController().signal },
    )

    expect(calls).toHaveLength(1)
    expect(results).toHaveLength(2)
  })

  test("execute falls back to raw results when the gate errors", async () => {
    const { ctx, editor } = makeContext({ apiKey: "k", gate: { apiKey: "typesafe" } })
    await plugin.setup(ctx as never)

    routeFetch({
      [ENDPOINT]: () => jsonResponse(samplePayload),
      [DEFAULT_GATE_ENDPOINT]: () => new Response("boom", { status: 500 }),
    })

    const results = await editor.added[0]!.execute(
      { query: "q" },
      { signal: new AbortController().signal },
    )
    expect(results).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Local duplicate filter
//
// Fixtures model the three duplicate shapes actually observed in live
// LangSearch output (see RESEARCH.md): a print variant of the same URL, a
// mirror of another page's body, and two pages sharing a boilerplate block.
// The fourth shape — two independent pages stating the same fact — is the one
// that must survive, because it is corroboration rather than redundancy.
// ---------------------------------------------------------------------------

const BOILERPLATE =
  "The height of Mount Fuji is 11,388 feet. Mount Fuji is in Japan and it is the highest mountain there. " +
  "In Tokyo, Japan. Mount Fuji's height is 3,776 meters. Mount Fuji's elevation is 12,388 feet. " +
  "Mount Fuji is classified as a dormant volcano. Mount Fuji last erupted in 1707."

function result(url: string, content: string, title = url): LangSearchResult {
  return { url, title, content, time: {} }
}

describe("canonicalizeUrl", () => {
  test("collapses a print variant and its tracking parameter onto the article", () => {
    // The exact pair returned live for "What is the population of Tokyo?".
    const article = "https://livejapan.com/en/in-tokyo/in-pref-tokyo/in-tokyo_suburbs/article-a0002533/"
    const print =
      "https://livejapan.com/en/in-tokyo/in-pref-tokyo/in-tokyo_suburbs/article-a0002533/print.html?sc_lid=lj_pc_article_print01"
    expect(canonicalizeUrl(print)).toBe(canonicalizeUrl(article))
  })

  test("ignores fragments, www, trailing slashes, index pages and amp copies", () => {
    const canonical = canonicalizeUrl("https://example.com/story")
    expect(canonicalizeUrl("https://www.example.com/story/")).toBe(canonical)
    expect(canonicalizeUrl("https://example.com/story#section-2")).toBe(canonical)
    expect(canonicalizeUrl("https://example.com/story/index.html")).toBe(canonical)
    expect(canonicalizeUrl("https://example.com/story/amp")).toBe(canonical)
  })

  test("strips tracking parameters but keeps meaningful ones", () => {
    expect(canonicalizeUrl("https://example.com/p?utm_source=x&id=7&fbclid=y")).toBe("example.com/p?id=7")
  })

  test("treats differently-ordered query strings as the same page", () => {
    expect(canonicalizeUrl("https://example.com/p?b=2&a=1")).toBe(canonicalizeUrl("https://example.com/p?a=1&b=2"))
  })

  test("does not collapse genuinely different pages", () => {
    expect(canonicalizeUrl("https://example.com/a")).not.toBe(canonicalizeUrl("https://example.com/b"))
  })

  test("falls back to the raw string for an unparseable url", () => {
    expect(canonicalizeUrl("not a url")).toBe("not a url")
  })
})

describe("shingles and containment", () => {
  test("containment measures the smaller set inside the larger", () => {
    const small = shingles("alpha beta gamma delta epsilon")
    const large = shingles("prefix words alpha beta gamma delta epsilon and a good deal more text after")
    expect(small.size).toBe(1)
    expect(containment(small, large)).toBe(1)
    // Order of arguments must not matter.
    expect(containment(large, small)).toBe(1)
  })

  test("independent prose about the same subject shares almost nothing", () => {
    const a = shingles("Mount Fuji stands three thousand seven hundred and seventy six metres above sea level")
    const b = shingles("Japan's tallest peak rises to a height of 3,776 m on the island of Honshu")
    expect(containment(a, b)).toBeLessThan(OBSERVED_CONTAINMENT_GAP.distinctMax)
  })

  test("an empty body never matches", () => {
    expect(containment(shingles(""), shingles("some words that form several shingles here"))).toBe(0)
  })
})

describe("dedupeResults", () => {
  test("drops a print variant of a page already kept", () => {
    const outcome = dedupeResults([
      result("https://livejapan.com/en/article-a0002533/", "Tokyo has a population of roughly fourteen million people."),
      result(
        "https://livejapan.com/en/article-a0002533/print.html?sc_lid=lj_pc_article_print01",
        "Tokyo has a population of roughly fourteen million people.",
      ),
    ])

    expect(outcome.results).toHaveLength(1)
    expect(outcome.dropped).toEqual([
      {
        index: 1,
        url: "https://livejapan.com/en/article-a0002533/print.html?sc_lid=lj_pc_article_print01",
        duplicateOf: 0,
        reason: "url",
      },
    ])
  })

  test("drops a mirror that republishes another page's body at a different url", () => {
    const outcome = dedupeResults([
      result("https://en.wikipedia.org/wiki/Eiffel_Tower", `The tower was completed in 1889. ${BOILERPLATE}`),
      result("https://timelineindex.com/content/clickout.php?siteid=1155", `The tower was completed in 1889. ${BOILERPLATE}`),
    ])

    expect(outcome.results.map((r) => r.url)).toEqual(["https://en.wikipedia.org/wiki/Eiffel_Tower"])
    expect(outcome.dropped[0]!.reason).toBe("content")
    expect(outcome.dropped[0]!.containment).toBeGreaterThanOrEqual(DEFAULT_MIN_CONTAINMENT)
  })

  test("drops a page whose body is a superset of one already kept", () => {
    // Containment, not Jaccard: a copy padded with navigation text is still a copy.
    const outcome = dedupeResults([
      result("https://a.example/q1", BOILERPLATE),
      result("https://a.example/q2", `Is Mount Fuji a constructive force? It is both. ${BOILERPLATE} Extra trailing chatter.`),
    ])

    expect(outcome.results).toHaveLength(1)
    expect(outcome.dropped[0]!.duplicateOf).toBe(0)
  })

  test("keeps two independent pages that state the same fact", () => {
    // The case a semantic dedupe pass got wrong: both answer the question, in
    // their own words, and one is the source that states it correctly. When
    // sources disagree this corroboration is the evidence that settles it.
    const outcome = dedupeResults([
      result(
        "https://www.answers.com/travel-destinations/What_is_the_length_of_mount_fuji",
        "Mount Fuji, Japan's tallest peak, stands at approximately 3,776 metres above sea level, and its base has a diameter of about forty kilometres.",
      ),
      result(
        "https://wheatoncollege.edu/arts/mt-fuji/",
        "Ogata Gekko created this print in the late nineteenth century; the tallest mountain in Japan rises 12,380 feet atop a triple junction of tectonic plates.",
      ),
    ])

    expect(outcome.results).toHaveLength(2)
    expect(outcome.dropped).toHaveLength(0)
  })

  test("keeps the first occurrence and preserves provider order", () => {
    const outcome = dedupeResults([
      result("https://a.example/1", "unique alpha text with plenty of distinct words to compare against later"),
      result("https://b.example/2", BOILERPLATE),
      result("https://c.example/3", BOILERPLATE),
      result("https://d.example/4", "unique delta text with plenty of distinct words to compare against later"),
    ])

    expect(outcome.results.map((r) => r.url)).toEqual([
      "https://a.example/1",
      "https://b.example/2",
      "https://d.example/4",
    ])
    expect(outcome.dropped.map((d) => d.index)).toEqual([2])
  })

  test("does not judge short bodies by shingle overlap", () => {
    // The floor exists so two short snippets are not collapsed on a coincidental
    // overlap. Identical short bodies are still duplicates — that is the exact
    // match above, not this check.
    const a = "Mount Fuji is tall."
    const b = "Mount Fuji is in Japan."
    expect(shingles(a).size).toBeLessThan(MIN_SHINGLES)
    expect(shingles(b).size).toBeLessThan(MIN_SHINGLES)
    const outcome = dedupeResults([result("https://a.example/1", a), result("https://b.example/2", b)])
    expect(outcome.results).toHaveLength(2)
  })

  test("tolerates missing and empty bodies", () => {
    const outcome = dedupeResults([
      { url: "https://a.example/1", time: {} },
      { url: "https://b.example/2", content: "", time: {} },
    ])
    expect(outcome.results).toHaveLength(2)
  })

  test("honours a custom containment threshold", () => {
    // These two share 0.63 containment — a partial overlap that straddles the
    // default, so the threshold is what decides the outcome.
    const pair = [
      result("https://a.example/1", BOILERPLATE),
      result(
        "https://b.example/2",
        "The height of Mount Fuji is 11,388 feet. Mount Fuji is in Japan and it is the highest mountain there. " +
          "Entirely separate closing paragraph about cherry blossoms, shrines, pilgrims and the sunrise climb known as Goraiko.",
      ),
    ]
    expect(dedupeResults(pair, { minContainment: 0.5 }).results).toHaveLength(1)
    expect(dedupeResults(pair, { minContainment: 0.7 }).results).toHaveLength(2)
    // The default is deliberately on the permissive side of this case.
    expect(dedupeResults(pair).results).toHaveLength(2)
  })

  test("an out-of-range threshold is clamped rather than trusted", () => {
    const pair = [result("https://a.example/1", BOILERPLATE), result("https://b.example/2", BOILERPLATE)]
    expect(dedupeResults(pair, { minContainment: 1.5 }).results).toHaveLength(1)
    expect(dedupeResults(pair, { minContainment: Number.NaN }).results).toHaveLength(1)
  })

  test("returns everything unchanged for zero or one result", () => {
    expect(dedupeResults([]).results).toEqual([])
    const one = [result("https://a.example/1", BOILERPLATE)]
    expect(dedupeResults(one).results).toEqual(one)
  })

  test("the default threshold sits inside the gap measured on live results", () => {
    // Guards the one tuned constant: live copies scored >= 0.873 and
    // independent pages <= 0.030. A default outside that band is a regression.
    expect(DEFAULT_MIN_CONTAINMENT).toBeGreaterThan(OBSERVED_CONTAINMENT_GAP.distinctMax)
    expect(DEFAULT_MIN_CONTAINMENT).toBeLessThan(OBSERVED_CONTAINMENT_GAP.duplicateMin)
  })
})

describe("normalizeDedupeOption", () => {
  test("is on unless explicitly disabled", () => {
    expect(normalizeDedupeOption(undefined)).toEqual({})
    expect(normalizeDedupeOption(true)).toEqual({})
    expect(normalizeDedupeOption({ minContainment: 0.9 })).toEqual({ minContainment: 0.9 })
    expect(normalizeDedupeOption(false)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Disagreement signal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wiring: deduplicate before the gate, annotate after the tool
// ---------------------------------------------------------------------------

describe("plugin integration: duplicate collapsing", () => {
  const duplicatePayload = {
    code: 200,
    data: {
      webPages: {
        value: [
          { url: "https://a.example/story", name: "Story", text: BOILERPLATE },
          { url: "https://www.a.example/story/print.html?utm_source=x", name: "Story (print)", text: BOILERPLATE },
          { url: "https://b.example/mirror", name: "Mirror", text: BOILERPLATE },
          {
            url: "https://c.example/independent",
            name: "Independent",
            text: "Ogata Gekko created this print in the late nineteenth century; the peak rises 12,380 feet atop a triple junction of tectonic plates.",
          },
        ],
      },
    },
  }

  function gateBody(calls: Array<{ url: string; init?: RequestInit }>) {
    const gateCall = calls.find((call) => call.url === DEFAULT_GATE_ENDPOINT)
    return JSON.parse(String(gateCall!.init!.body)) as ReturnType<typeof buildGateRequest>
  }

  test("duplicates are dropped before the gate ever sees them", async () => {
    const { ctx, editor } = makeContext({ apiKey: "k", gate: {} })
    await plugin.setup(ctx as never)

    const calls = routeFetch({
      [ENDPOINT]: () => jsonResponse(duplicatePayload),
      [DEFAULT_GATE_ENDPOINT]: () =>
        systemOneResponse({
          relevant_0: 0.9,
          evidence_0: 0.9,
          injection_0: 0.01,
          relevant_1: 0.9,
          evidence_1: 0.9,
          injection_1: 0.01,
          agreement: 0.1,
        }),
    })

    const results = await editor.added[0]!.execute(
      { query: "eiffel tower" },
      { signal: new AbortController().signal },
    )

    // Two copies removed locally; the survivors are the original and the
    // independent page. The gate is billed for two results, not four.
    const state = gateBody(calls).state
    expect(Object.keys(state.results)).toHaveLength(2)
    expect(Object.values(state.results).map((r) => r.url)).toEqual([
      "https://a.example/story",
      "https://c.example/independent",
    ])
    expect(results.map((r) => r.url)).toEqual(["https://a.example/story", "https://c.example/independent"])
  })

  test("dedupe can be turned off", async () => {
    const { ctx, editor } = makeContext({ apiKey: "k", gate: {}, dedupe: false })
    await plugin.setup(ctx as never)

    const calls = routeFetch({
      [ENDPOINT]: () => jsonResponse(duplicatePayload),
      [DEFAULT_GATE_ENDPOINT]: () => systemOneResponse({ agreement: 0.1 }),
    })
    await editor.added[0]!.execute({ query: "eiffel tower" }, { signal: new AbortController().signal })

    expect(Object.keys(gateBody(calls).state.results)).toHaveLength(4)
  })

  test("dedupe still runs when the gate is off", async () => {
    const { ctx, editor } = makeContext({ apiKey: "k" })
    await plugin.setup(ctx as never)

    stubFetch(() => jsonResponse(duplicatePayload))
    const results = await editor.added[0]!.execute(
      { query: "eiffel tower" },
      { signal: new AbortController().signal },
    )

    expect(results.map((r) => r.url)).toEqual(["https://a.example/story", "https://c.example/independent"])
  })

  test("nothing is annotated when the sources agree", async () => {
    const { ctx, editor, fireToolHook } = makeContext({ apiKey: "k", gate: {} })
    await plugin.setup(ctx as never)

    routeFetch({
      [ENDPOINT]: () => jsonResponse(samplePayload),
      [DEFAULT_GATE_ENDPOINT]: () =>
        systemOneResponse({
          relevant_0: 0.9,
          evidence_0: 0.9,
          injection_0: 0.01,
          relevant_1: 0.9,
          evidence_1: 0.9,
          injection_1: 0.01,
          agreement: 0.16,
        }),
    })

    await editor.added[0]!.execute({ query: "mount fuji" }, { signal: new AbortController().signal })
    const event = await fireToolHook({
      tool: "websearch",
      status: "completed",
      input: { query: "mount fuji" },
      result: { content: [{ type: "text", text: "## results" }] },
    })

    expect((event.result as { content: unknown[] }).content).toHaveLength(1)
  })

  test("a host without `tool.hook` still registers the provider and searches", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      // Only the debug trace needs the hook now, so the warning is tied to it.
      const { ctx, editor } = makeContext({ apiKey: "k", gate: {}, debug: true }, { withToolHook: false })
      await plugin.setup(ctx as never)

      expect(editor.added).toHaveLength(1)
      expect(warn.mock.calls.flat().join(" ")).toContain("tool.hook")

      routeFetch({
        [ENDPOINT]: () => jsonResponse(samplePayload),
        [DEFAULT_GATE_ENDPOINT]: () =>
          systemOneResponse({
            relevant_0: 0.9,
            evidence_0: 0.9,
            injection_0: 0.01,
            relevant_1: 0.9,
            evidence_1: 0.9,
            injection_1: 0.01,
            agreement: 0.99,
          }),
      })
      const results = await editor.added[0]!.execute(
        { query: "mount fuji" },
        { signal: new AbortController().signal },
      )
      expect(results.length).toBeGreaterThan(0)
    } finally {
      warn.mockRestore()
    }
  })

  test("the gate still fails open with dedupe and the agreement question enabled", async () => {
    const { ctx, editor } = makeContext({ apiKey: "k", gate: {} })
    await plugin.setup(ctx as never)

    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      routeFetch({
        [ENDPOINT]: () => jsonResponse(duplicatePayload),
        [DEFAULT_GATE_ENDPOINT]: () => new Response("boom", { status: 500 }),
      })
      const results = await editor.added[0]!.execute(
        { query: "eiffel tower" },
        { signal: new AbortController().signal },
      )
      // Deduplicated (local, always safe) but otherwise unfiltered.
      expect(results.map((r) => r.url)).toEqual(["https://a.example/story", "https://c.example/independent"])
    } finally {
      warn.mockRestore()
    }
  })
})

describe("note store staleness", () => {
  test("a note whose hook never fired is not delivered to a later search", async () => {
    const { ctx, editor, fireToolHook } = makeContext({ apiKey: "k", gate: {} })
    await plugin.setup(ctx as never)

    const answers = (agreement: number) => ({
      relevant_0: 0.9,
      evidence_0: 0.9,
      injection_0: 0.01,
      relevant_1: 0.9,
      evidence_1: 0.9,
      injection_1: 0.01,
      agreement,
    })

    // First search disagrees, but the host never fires the hook.
    routeFetch({
      [ENDPOINT]: () => jsonResponse(samplePayload),
      [DEFAULT_GATE_ENDPOINT]: () => systemOneResponse(answers(0.93)),
    })
    await editor.added[0]!.execute({ query: "mount fuji" }, { signal: new AbortController().signal })

    // The same query is searched again and this time the sources agree.
    routeFetch({
      [ENDPOINT]: () => jsonResponse(samplePayload),
      [DEFAULT_GATE_ENDPOINT]: () => systemOneResponse(answers(0.12)),
    })
    await editor.added[0]!.execute({ query: "mount fuji" }, { signal: new AbortController().signal })

    const event = await fireToolHook({
      tool: "websearch",
      status: "completed",
      input: { query: "mount fuji" },
      result: { content: [{ type: "text", text: "## results" }] },
    })
    expect((event.result as { content: unknown[] }).content).toHaveLength(1)
  })
})

describe("dedupeResults: short identical bodies", () => {
  test("byte-identical bodies are duplicates even below the shingle floor", () => {
    // Observed live for "How do I reverse a string in Python?": LangSearch
    // returned five copies of the same 26-character stub, each on its own URL.
    const stub = "reverse a string in Python"
    expect(shingles(stub).size).toBeLessThan(MIN_SHINGLES)

    const outcome = dedupeResults([
      result("https://love-python.blogspot.com/a", stub),
      result("https://love-python.blogspot.com/b", stub),
      result("https://love-python.blogspot.com/c", stub),
      result("https://other.example/x", "An entirely different short page."),
    ])

    expect(outcome.results.map((r) => r.url)).toEqual([
      "https://love-python.blogspot.com/a",
      "https://other.example/x",
    ])
    expect(outcome.dropped.every((d) => d.duplicateOf === 0)).toBe(true)
  })

  test("matching ignores whitespace and case but not wording", () => {
    const outcome = dedupeResults([
      result("https://a.example/1", "Reverse a string"),
      result("https://b.example/2", "  reverse   a  STRING  "),
      result("https://c.example/3", "Reverse a list"),
    ])
    expect(outcome.results.map((r) => r.url)).toEqual(["https://a.example/1", "https://c.example/3"])
  })
})

// ---------------------------------------------------------------------------
// Passage trimming
// ---------------------------------------------------------------------------

const PAGE = [
  "Mount Fuji stands 3,776 metres above sea level, the highest mountain in Japan.",
  "Subscribe to our newsletter for weekly travel deals and exclusive discounts.",
  "The mountain last erupted in 1707 and is still classed as an active volcano.",
  "Cookie preferences · Privacy policy · Terms of service · Contact us",
].join("\n\n")

function trimAnswers(scores: Record<string, number>) {
  return systemOneResponse(Object.fromEntries(Object.entries(scores).map(([k, v]) => [`passage_${k}`, v])))
}

describe("splitPassages", () => {
  test("splits on blank lines and keeps order", () => {
    expect(splitPassages(PAGE)).toHaveLength(4)
    expect(splitPassages(PAGE)[0]).toContain("3,776")
  })

  test("joins fragments too short to score onto the passage before them", () => {
    const withByline = "A long opening paragraph that easily clears the minimum length for its own passage.\nKatie\nMore text that also clears the minimum length on its own line here."
    const passages = splitPassages(withByline)
    expect(passages).toHaveLength(2)
    expect(passages[0]).toContain("Katie")
  })

  test("never emits an empty passage", () => {
    expect(splitPassages("\n\n\n")).toEqual([])
    expect(splitPassages("")).toEqual([])
  })
})

describe("resolveTrimThreshold", () => {
  test("defaults on, false disables, numbers override and clamp", () => {
    expect(resolveTrimThreshold(undefined)).toBe(DEFAULT_MIN_PASSAGE)
    expect(resolveTrimThreshold(true)).toBe(DEFAULT_MIN_PASSAGE)
    expect(resolveTrimThreshold(false)).toBeUndefined()
    expect(resolveTrimThreshold(0.7)).toBe(0.7)
    expect(resolveTrimThreshold(5)).toBe(1)
    expect(resolveTrimThreshold(Number.NaN)).toBe(DEFAULT_MIN_PASSAGE)
  })
})

describe("buildTrimRequest", () => {
  test("asks one question per passage and carries the text in state", () => {
    const { request, index } = buildTrimRequest("How tall is Mount Fuji?", [result("https://a.example/1", PAGE)])
    expect(index).toHaveLength(4)
    expect(Object.keys(request.questions)).toHaveLength(4)
    expect(Object.keys(request.state.passages!)).toHaveLength(4)
    expect(request.questions[`passage_${index[0]!.key}`]!.type).toBe("noul")
  })

  test("stops at the passage and character limits", () => {
    const huge = Array.from({ length: 400 }, (_, i) => `Paragraph number ${i} with enough text to be its own passage.`).join("\n\n")
    const { index } = buildTrimRequest("q", [result("https://a.example/1", huge)])
    expect(index.length).toBeLessThanOrEqual(TRIM_LIMITS.maxPassages)
    expect(index.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(TRIM_LIMITS.maxChars)
  })
})

describe("trimResults", () => {
  const one = [result("https://a.example/1", PAGE)]

  test("keeps the passages that bear on the query and drops the rest", async () => {
    const { index } = buildTrimRequest("How tall is Mount Fuji?", one)
    stubFetch(() =>
      trimAnswers({
        [index[0]!.key]: 0.99, // the height
        [index[1]!.key]: 0.02, // newsletter
        [index[2]!.key]: 0.81, // eruption
        [index[3]!.key]: 0.01, // cookie footer
      }),
    )
    const outcome = await trimResults("How tall is Mount Fuji?", one, { apiKey: "k" })
    expect(outcome.results[0]!.content).toContain("3,776")
    expect(outcome.results[0]!.content).toContain("1707")
    expect(outcome.results[0]!.content).not.toContain("newsletter")
    expect(outcome.results[0]!.content).not.toContain("Cookie")
    expect(outcome.passagesKept).toBe(2)
    expect(outcome.charsAfter).toBeLessThan(outcome.charsBefore)
  })

  test("a result never comes back empty: its best passage survives", async () => {
    const { index } = buildTrimRequest("q", one)
    stubFetch(() => trimAnswers(Object.fromEntries(index.map((e, i) => [e.key, i === 2 ? 0.4 : 0.01]))))
    const outcome = await trimResults("q", one, { apiKey: "k" })
    expect(outcome.results[0]!.content).toBe(splitPassages(PAGE)[2])
    expect(outcome.passagesKept).toBe(1)
  })

  test("an unjudged passage is kept rather than silently dropped", async () => {
    stubFetch(() => systemOneResponse({}))
    const outcome = await trimResults("q", one, { apiKey: "k" })
    expect(outcome.results[0]!.content).toBe(PAGE.split("\n\n").join("\n\n"))
    expect(outcome.passagesKept).toBe(4)
  })

  test("skips the request when there is nothing to choose between", async () => {
    const calls = stubFetch(() => systemOneResponse({}))
    const single = [result("https://a.example/1", "One single paragraph and nothing else to compare it against.")]
    const outcome = await trimResults("q", single, { apiKey: "k" })
    expect(calls).toHaveLength(0)
    expect(outcome.results).toEqual(single)
  })

  test("honours a custom threshold", async () => {
    const { index } = buildTrimRequest("q", one)
    const scores = { [index[0]!.key]: 0.9, [index[1]!.key]: 0.6, [index[2]!.key]: 0.6, [index[3]!.key]: 0.1 }
    stubFetch(() => trimAnswers(scores))
    expect((await trimResults("q", one, { apiKey: "k", trimPassages: 0.5 })).passagesKept).toBe(3)
    stubFetch(() => trimAnswers(scores))
    expect((await trimResults("q", one, { apiKey: "k", trimPassages: 0.8 })).passagesKept).toBe(1)
  })

  test("preserves result identity and order", async () => {
    const two = [result("https://a.example/1", PAGE, "First"), result("https://b.example/2", PAGE, "Second")]
    const { index } = buildTrimRequest("q", two)
    stubFetch(() => trimAnswers(Object.fromEntries(index.map((e) => [e.key, 0.9]))))
    const outcome = await trimResults("q", two, { apiKey: "k" })
    expect(outcome.results.map((r) => r.url)).toEqual(["https://a.example/1", "https://b.example/2"])
    expect(outcome.results.map((r) => r.title)).toEqual(["First", "Second"])
  })
})

describe("gate integration: trimming", () => {
  const payload = {
    code: 200,
    data: { webPages: { value: [{ url: "https://a.example/1", name: "A", text: PAGE }] } },
  }

  async function runExecute(gate: Record<string, unknown>, trimHandler: () => Response) {
    const { ctx, editor } = makeContext({ apiKey: "k", gate })
    await plugin.setup(ctx as never)
    let gateCalls = 0
    routeFetch({
      [ENDPOINT]: () => jsonResponse(payload),
      [DEFAULT_GATE_ENDPOINT]: () => {
        gateCalls++
        return gateCalls === 1
          ? systemOneResponse({ relevant_0: 0.95, evidence_0: 0.95, injection_0: 0.01 })
          : trimHandler()
      },
    })
    const results = await editor.added[0]!.execute({ query: "How tall is Mount Fuji?" }, { signal: new AbortController().signal })
    return { results, gateCalls }
  }

  test("trims the results the gate chose", async () => {
    const { index } = buildTrimRequest("How tall is Mount Fuji?", [result("https://a.example/1", PAGE)])
    const { results, gateCalls } = await runExecute({}, () =>
      trimAnswers({ [index[0]!.key]: 0.99, [index[1]!.key]: 0.02, [index[2]!.key]: 0.9, [index[3]!.key]: 0.01 }),
    )
    expect(gateCalls).toBe(2)
    expect(results[0]!.content).toContain("3,776")
    expect(results[0]!.content).not.toContain("newsletter")
  })

  test("a failing trim request returns the gate's results untrimmed", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const { results, gateCalls } = await runExecute({}, () => new Response("boom", { status: 500 }))
      expect(gateCalls).toBe(2)
      expect(results[0]!.content).toBe(PAGE)
      expect(warn.mock.calls.flat().join(" ")).toContain("trim failed")
    } finally {
      warn.mockRestore()
    }
  })

  test("trimPassages:false skips the second request entirely", async () => {
    const { results, gateCalls } = await runExecute({ trimPassages: false }, () => systemOneResponse({}))
    expect(gateCalls).toBe(1)
    expect(results[0]!.content).toBe(PAGE)
  })
})

// ---------------------------------------------------------------------------
// Debug trace
// ---------------------------------------------------------------------------

/**
 * Poll until `check` returns a box, for filesystem writes the plugin does not
 * await. Boxed rather than sentinelled so that a falsy value can be waited for.
 */
async function waitFor<T>(check: () => { value: T } | undefined, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const box = check()
    if (box) return box.value
    if (Date.now() > deadline) throw new Error("timed out waiting for a value")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function sampleTrace(overrides: Partial<SearchTrace> = {}): SearchTrace {
  return {
    query: "mount fuji height",
    startedAt: "2026-09-20T00:00:00.000Z",
    found: 8,
    returned: 2,
    searchMs: 700,
    totalMs: 1000,
    ...overrides,
  }
}

describe("normalizeDebugOption", () => {
  test("is off unless asked for", () => {
    expect(normalizeDebugOption(undefined)).toBeUndefined()
    expect(normalizeDebugOption(false)).toBeUndefined()
  })

  test("true records to the tool result only", () => {
    expect(normalizeDebugOption(true)).toEqual({ metadata: true, verbose: false })
  })

  test("an object that records nowhere is disabled", () => {
    expect(normalizeDebugOption({ metadata: false })).toBeUndefined()
    expect(normalizeDebugOption({ metadata: false, file: "   " })).toBeUndefined()
  })

  test("expands a leading ~, which is how a path gets written in a config file", () => {
    const home = homedir()
    expect(resolveDebugFile("~/traces.jsonl")).toBe(join(home, "traces.jsonl"))
    expect(resolveDebugFile("  ~/a/b.jsonl  ")).toBe(join(home, "a/b.jsonl"))
    expect(resolveDebugFile("~")).toBe(home)
    expect(resolveDebugFile("/tmp/t.jsonl")).toBe("/tmp/t.jsonl")
    expect(resolveDebugFile("  ")).toBeUndefined()
    // Not a home reference: a file whose name merely starts with a tilde.
    expect(resolveDebugFile("~notauser/t.jsonl")).toBe("~notauser/t.jsonl")
    expect(normalizeDebugOption({ file: "~/t.jsonl" })!.file).toBe(join(home, "t.jsonl"))
  })

  test("a file alone is enough, and metadata stays on by default", () => {
    expect(normalizeDebugOption({ file: " /tmp/t.jsonl " })).toEqual({
      metadata: true,
      file: "/tmp/t.jsonl",
      verbose: false,
    })
    expect(normalizeDebugOption({ metadata: false, file: "/tmp/t.jsonl", verbose: true })).toEqual({
      metadata: false,
      file: "/tmp/t.jsonl",
      verbose: true,
    })
  })
})

describe("describeQuestions", () => {
  test("collapses the per-result questions into one entry per kind", () => {
    const request = buildGateRequest("q", [
      { url: "https://a.example", title: "A", content: "a", time: {} },
      { url: "https://b.example", title: "B", content: "b", time: {} },
    ])
    const described = describeQuestions(request.questions)

    expect(Object.keys(described).sort()).toEqual(["injection", "relevant"])
    expect(described.relevant!.asked).toBe(2)
    // The key a question pointed at is noise; the question itself is not.
    expect(described.relevant!.instructions).toContain("`results.<key>`")
    expect(described.relevant!.instructions).not.toContain("results.r0")
    // Criteria are optional and the shipped checks omit them: the question is
    // unambiguous on its own, which is what TypeSafe's own guidance asks for.
    expect(described.relevant!.criteria).toBeUndefined()
  })

  test("passage questions collapse too", () => {
    const { request } = buildTrimRequest("q", [
      { url: "https://a.example", content: `${"x".repeat(80)}\n${"y".repeat(80)}`, time: {} },
    ])
    const described = describeQuestions(request.questions)
    expect(Object.keys(described)).toEqual(["passage"])
    expect(described.passage!.asked).toBe(2)
    expect(described.passage!.instructions).toContain("`passages.<key>`")
  })
})

describe("resolveGateThresholds", () => {
  test("reports the defaults the gate actually applies", () => {
    expect(resolveGateThresholds()).toEqual({
      maxResults: 4,
      minRelevance: 0.45,
      maxInjection: 0.5,
    })
  })

  test("clamps out-of-range overrides", () => {
    expect(resolveGateThresholds({ maxResults: 999, minRelevance: 5, maxInjection: -2 })).toEqual({
      maxResults: 50,
      minRelevance: 1,
      maxInjection: 0,
    })
  })
})

describe("buildTrace", () => {
  const base = { query: "q", startedAt: Date.UTC(2026, 8, 20), searchMs: 100, totalMs: 200, found: 3, returned: 2 }

  test("records the search alone when nothing else ran", () => {
    const trace = buildTrace(base)
    expect(trace).toEqual({
      query: "q",
      startedAt: "2026-09-20T00:00:00.000Z",
      found: 3,
      returned: 2,
      searchMs: 100,
      totalMs: 200,
    })
  })

  test("records what the duplicate filter dropped", () => {
    const trace = buildTrace({
      ...base,
      dedupe: {},
      dropped: [{ index: 2, url: "https://c.example", duplicateOf: 0, reason: "url" }],
    })
    expect(trace.dedupe).toEqual({
      minContainment: DEFAULT_MIN_CONTAINMENT,
      dropped: [{ index: 2, url: "https://c.example", duplicateOf: 0, reason: "url" }],
    })
  })

  test("records the gate's questions, answers and decisions", () => {
    const results: LangSearchResult[] = [
      { url: "https://a.example", title: "A", content: "a", time: {} },
      { url: "https://b.example", title: "B", content: "b", time: {} },
    ]
    const collector: GateCollector = {
      gate: {
        results,
        decisions: [
          { index: 0, url: "https://a.example", relevant: 0.99, evidence: 0.98, injection: 0.01, kept: true, reason: "kept" },
          { index: 1, url: "https://b.example", relevant: 0.1, evidence: 0.1, injection: 0.02, kept: false, reason: "irrelevant" },
        ],
        usage: { inputTokens: 1200 },
        durationMs: 150,
        request: buildGateRequest("q", results),
      },
    }

    const trace = buildTrace({ ...base, gate: {}, collector })

    expect(trace.gate!.model).toBe(DEFAULT_GATE_MODEL)
    expect(trace.gate!.endpoint).toBe(DEFAULT_GATE_ENDPOINT)
    expect(trace.gate!.thresholds).toEqual(resolveGateThresholds())
    expect(trace.gate!.decisions).toHaveLength(2)
    expect(trace.gate!.usage.inputTokens).toBe(1200)
    expect(Object.keys(trace.gate!.questions)).toContain("relevant")
    // Nothing that was sent to jev is carried into the trace.
    expect(JSON.stringify(trace)).not.toContain("https://a.example/full-text")
  })

  test("records a gate failure rather than pretending it did not run", () => {
    const trace = buildTrace({ ...base, gate: {}, collector: { gateError: "HTTP 500" } })
    expect(trace.gate!.failed).toBe("HTTP 500")
    expect(trace.gate!.decisions).toEqual([])
    expect(trace.trim).toBeUndefined()
  })

  test("omits trimming when it is switched off", () => {
    const trace = buildTrace({ ...base, gate: { trimPassages: false }, collector: {} })
    expect(trace.trim).toBeUndefined()
  })

  test("records what trimming removed", () => {
    const trace = buildTrace({
      ...base,
      gate: {},
      collector: {
        trim: {
          results: [],
          passagesTotal: 40,
          passagesKept: 23,
          charsBefore: 10_000,
          charsAfter: 5_800,
          usage: { inputTokens: 3400 },
          durationMs: 150,
        },
      },
    })
    expect(trace.trim).toMatchObject({
      threshold: DEFAULT_MIN_PASSAGE,
      passagesTotal: 40,
      passagesKept: 23,
      charsBefore: 10_000,
      charsAfter: 5_800,
    })
  })

  test("records a trim failure", () => {
    const trace = buildTrace({ ...base, gate: {}, collector: { trimError: "timed out" } })
    expect(trace.trim!.failed).toBe("timed out")
  })
})

describe("buildVerboseRecord", () => {
  test("carries what was sent to jev and what came back", () => {
    const request = buildGateRequest("q", [{ url: "https://a.example", content: "body text", time: {} }])
    const record = buildVerboseRecord(sampleTrace(), {
      gate: { results: [], decisions: [], usage: {}, durationMs: 1, request, answers: { relevant_0: { noul: 0.9 } } },
    })
    expect(record.query).toBe("mount fuji height")
    expect(JSON.stringify(record.gateRequest)).toContain("body text")
    expect(record.gateAnswers).toEqual({ relevant_0: { noul: 0.9 } })
  })

  test("carries only the trace when the gate never ran", () => {
    expect(buildVerboseRecord(sampleTrace(), undefined)).toEqual({ ...sampleTrace() })
  })
})

describe("toJsonSafe and annotateToolMetadata", () => {
  test("drops values JSON cannot carry", () => {
    expect(toJsonSafe({ a: 1, b: undefined, c: [1, undefined] })).toEqual({ a: 1, c: [1, null] })
  })

  test("keeps the metadata the host already set", () => {
    const metadata = annotateToolMetadata({ provider: "langsearch" }, sampleTrace())
    expect(metadata.provider).toBe("langsearch")
    expect((metadata[TRACE_METADATA_KEY] as SearchTrace).query).toBe("mount fuji height")
  })

  test("survives metadata of an unexpected shape", () => {
    expect(annotateToolMetadata(undefined, sampleTrace())[TRACE_METADATA_KEY]).toBeDefined()
    expect(annotateToolMetadata("nonsense", sampleTrace())[TRACE_METADATA_KEY]).toBeDefined()
  })
})

describe("createTraceFileWriter", () => {
  test("appends one JSON object per line", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "langsearch-debug-")), "trace.jsonl")
    const write = createTraceFileWriter(file)
    await write({ query: "one" })
    await write({ query: "two" })

    const lines = readFileSync(file, "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).query).toBe("one")
    expect(JSON.parse(lines[1]!).query).toBe("two")
  })

  test("a bad path warns once and never throws", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const write = createTraceFileWriter(join(tmpdir(), "langsearch-missing-dir", "nested", "trace.jsonl"))
      await write({ query: "one" })
      await write({ query: "two" })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("createPendingStore", () => {
  test("hands each entry over exactly once", () => {
    const store = createPendingStore<number>()
    store.set("q", 1)
    expect(store.take("q")).toBe(1)
    expect(store.take("q")).toBeUndefined()
  })

  test("clear drops a stale entry", () => {
    const store = createTraceStore()
    store.set("q", sampleTrace())
    store.clear("q")
    expect(store.take("q")).toBeUndefined()
  })

  test("evicts the oldest past the limit", () => {
    const store = createPendingStore<number>(2)
    store.set("a", 1)
    store.set("b", 2)
    store.set("c", 3)
    expect(store.size).toBe(2)
    expect(store.take("a")).toBeUndefined()
    expect(store.take("c")).toBe(3)
  })

})

describe("plugin debug trace", () => {
  const gateAnswers = {
    relevant_0: 0.99,
    injection_0: 0.01,
    relevant_1: 0.9,
    injection_1: 0.02,
    agreement: 0.2,
  }

  test("attaches the trace to the tool result metadata, not to its content", async () => {
    const { ctx, editor, fireToolHook } = makeContext({
      apiKey: "k",
      debug: true,
      gate: { apiKey: "typesafe", trimPassages: false },
    })
    await plugin.setup(ctx as never)

    routeFetch({
      [ENDPOINT]: () => jsonResponse(samplePayload),
      [DEFAULT_GATE_ENDPOINT]: () => systemOneResponse(gateAnswers),
    })

    await editor.added[0]!.execute({ query: "mount fuji" }, { signal: new AbortController().signal })

    const event = await fireToolHook({
      tool: "websearch",
      status: "completed",
      input: { query: "mount fuji" },
      result: { output: { provider: "langsearch" }, content: [{ type: "text", text: "## results" }] },
    })

    const result = event.result as { content: Array<{ type: string; text: string }>; metadata: Record<string, unknown> }
    // The sources agree here, so nothing was added to what the model reads.
    expect(result.content).toEqual([{ type: "text", text: "## results" }])

    const trace = result.metadata[TRACE_METADATA_KEY] as SearchTrace
    expect(trace.query).toBe("mount fuji")
    expect(trace.found).toBe(2)
    expect(trace.returned).toBe(2)
    expect(trace.gate!.decisions).toHaveLength(2)
    expect(trace.gate!.decisions[0]!.kept).toBe(true)
    expect(trace.gate!.decisions[1]!.reason).toBe("kept")
    expect(trace.gate!.flagged).toBeUndefined()
    expect(Object.keys(trace.gate!.questions)).toContain("injection")
  })

  test("records a search the gate never saw", async () => {
    const { ctx, editor, fireToolHook } = makeContext({ apiKey: "k", debug: true })
    await plugin.setup(ctx as never)
    stubFetch(() => jsonResponse(samplePayload))

    await editor.added[0]!.execute({ query: "plain search" }, { signal: new AbortController().signal })
    const event = await fireToolHook({
      tool: "websearch",
      status: "completed",
      input: { query: "plain search" },
      result: { content: [] },
    })

    const trace = (event.result as { metadata: Record<string, unknown> }).metadata[TRACE_METADATA_KEY] as SearchTrace
    expect(trace.gate).toBeUndefined()
    expect(trace.dedupe).toBeDefined()
    expect(trace.returned).toBe(2)
  })

  test("nothing is attached when debug is off", async () => {
    const { ctx, editor, fireToolHook } = makeContext({ apiKey: "k", gate: { apiKey: "typesafe" } })
    await plugin.setup(ctx as never)

    routeFetch({
      [ENDPOINT]: () => jsonResponse(samplePayload),
      [DEFAULT_GATE_ENDPOINT]: () => systemOneResponse(gateAnswers),
    })

    await editor.added[0]!.execute({ query: "mount fuji" }, { signal: new AbortController().signal })
    const event = await fireToolHook({
      tool: "websearch",
      status: "completed",
      input: { query: "mount fuji" },
      result: { content: [] },
    })
    expect((event.result as { metadata?: unknown }).metadata).toBeUndefined()
  })

  test("writes the debug file, and the verbose record carries what jev was sent", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "langsearch-e2e-")), "trace.jsonl")
    const { ctx, editor } = makeContext({
      apiKey: "k",
      debug: { metadata: false, file, verbose: true },
      gate: { apiKey: "typesafe", trimPassages: false },
    })
    await plugin.setup(ctx as never)

    routeFetch({
      [ENDPOINT]: () => jsonResponse(samplePayload),
      [DEFAULT_GATE_ENDPOINT]: () => systemOneResponse(gateAnswers),
    })

    await editor.added[0]!.execute({ query: "mount fuji" }, { signal: new AbortController().signal })

    const line = await waitFor(() => {
      try {
        const text = readFileSync(file, "utf8").trim()
        return text ? { value: text } : undefined
      } catch {
        return undefined
      }
    })

    const record = JSON.parse(line)
    expect(record.query).toBe("mount fuji")
    expect(record.gate.decisions).toHaveLength(2)
    // The page bodies are in the verbose record and nowhere else.
    expect(JSON.stringify(record.gateRequest)).toContain("Full text A")
    expect(record.gateAnswers.relevant_0.noul).toBe(0.99)
  })

  test("the publication date reaches the results the transform returns", async () => {
    // withDateline is unit-tested in isolation; this asserts it is actually
    // wired into the path the model reads from.
    const { ctx, editor } = makeContext({ apiKey: "k" })
    await plugin.setup(ctx as never)
    stubFetch(() =>
      jsonResponse({
        code: 200,
        data: {
          webPages: {
            value: [
              { url: "https://dated.example", name: "Dated", text: "a dated body", datePublished: "2018-09-16T07:08:14.000Z" },
              { url: "https://undated.example", name: "Undated", text: "a quite different body" },
            ],
          },
        },
      }),
    )

    const results = await editor.added[0]!.execute({ query: "q" }, { signal: new AbortController().signal })
    expect(results[0]!.content).toBe("Published: 2018-09-16\n\na dated body")
    expect(results[0]!.time.published).toBe(Date.UTC(2018, 8, 16, 7, 8, 14))
    expect(results[1]!.content).toBe("a quite different body")
  })

  test("the debug file is written even when the host exposes no tool hook", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "langsearch-nohook-")), "trace.jsonl")
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const { ctx, editor } = makeContext({ apiKey: "k", debug: { file } }, { withToolHook: false })
      await plugin.setup(ctx as never)
      stubFetch(() => jsonResponse(samplePayload))

      await editor.added[0]!.execute({ query: "no hook" }, { signal: new AbortController().signal })
      const line = await waitFor(() => {
        try {
          const text = readFileSync(file, "utf8").trim()
          return text ? { value: text } : undefined
        } catch {
          return undefined
        }
      })
      expect(JSON.parse(line).query).toBe("no hook")
    } finally {
      warn.mockRestore()
    }
  })

  test("a trace from an abandoned search is never delivered to the next one", async () => {
    const { ctx, editor, fireToolHook } = makeContext({ apiKey: "k", debug: true })
    await plugin.setup(ctx as never)
    stubFetch(() => jsonResponse(samplePayload))

    // Two searches for the same query, only one hook firing: the first trace
    // must be discarded rather than attached to the second result.
    await editor.added[0]!.execute({ query: "repeat" }, { signal: new AbortController().signal })
    await editor.added[0]!.execute({ query: "repeat" }, { signal: new AbortController().signal })

    const first = await fireToolHook({
      tool: "websearch",
      status: "completed",
      input: { query: "repeat" },
      result: { content: [] },
    })
    expect((first.result as { metadata: Record<string, unknown> }).metadata[TRACE_METADATA_KEY]).toBeDefined()

    const second = await fireToolHook({
      tool: "websearch",
      status: "completed",
      input: { query: "repeat" },
      result: { content: [] },
    })
    expect((second.result as { metadata?: unknown }).metadata).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// TUI half
// ---------------------------------------------------------------------------

type FakeTui = {
  ctx: TuiContext
  toasts: TuiToastOptions[]
  alerts: Array<{ title: string; message: string }>
  /** Render callbacks handed to `dialog.show`. */
  shown: Array<() => unknown>
  /** Texts handed to the renderer's OSC 52 clipboard. */
  copied: string[]
  emit: (event: Parameters<Parameters<TuiContext["data"]["on"]>[1]>[0]) => void
  run: () => Promise<void>
  commandIds: () => string[]
  /** Slash names (not aliases) the commands expose. */
  slashNames: () => string[]
  /** Render the claims the plugin appended to the `app` slot, as the host does. */
  renderSlots: () => void
  /** What the next `dialog.select` returns. */
  choose: (value: unknown) => void
  /** Options offered to the most recent `dialog.select`. */
  selectOptions: () => ReadonlyArray<{ title: string }>
}

function makeTui(options: Record<string, unknown> = {}, directory?: string): FakeTui {
  const toasts: TuiToastOptions[] = []
  const alerts: Array<{ title: string; message: string }> = []
  const shown: Array<() => unknown> = []
  const copied: string[] = []
  const handlers: Array<(event: never) => void> = []
  const commands: Array<{
    id?: string
    slash?: { name: string; aliases?: string[] }
    run: () => void | false | Promise<void>
  }> = []
  const slots: Array<{ append: string; render: (input: never) => unknown }> = []
  let nextChoice: unknown
  let lastSelectOptions: ReadonlyArray<{ title: string }> = []

  const ctx: TuiContext = {
    options,
    location: directory ? { directory } : undefined,
    renderer: {
      copyToClipboardOSC52: (text) => {
        copied.push(text)
        return true
      },
    },
    ui: {
      toast: { show: (toast) => toasts.push(toast) },
      dialog: {
        show: (render) => {
          shown.push(render)
        },
        set: () => {},
        clear: () => {},
        alert: async (alert) => {
          alerts.push(alert)
        },
        select: async <Value,>(input: unknown): Promise<Value | undefined> => {
          lastSelectOptions = (input as { options: ReadonlyArray<{ title: string }> }).options
          return nextChoice as Value | undefined
        },
      },
      slot: (claim) => {
        slots.push(claim as { append: string; render: (input: never) => unknown })
        return () => {
          const index = slots.indexOf(claim as { append: string; render: (input: never) => unknown })
          if (index >= 0) slots.splice(index, 1)
        }
      },
    },
    keymap: {
      layer: (input) => {
        for (const command of input().commands ?? []) commands.push(command)
      },
    },
    data: {
      on: (_type, handler) => {
        handlers.push(handler as (event: never) => void)
        return () => {}
      },
    },
  }

  return {
    ctx,
    toasts,
    alerts,
    shown,
    copied,
    renderSlots: () => {
      // The host renders a claim inside its component tree, which is the only
      // place `keymap.layer` may be called.
      for (const claim of slots) (claim.render as (input: unknown) => unknown)({})
    },
    emit: (event) => {
      for (const handler of handlers) (handler as (value: unknown) => void)(event)
    },
    run: async () => {
      for (const command of commands) await command.run()
    },
    commandIds: () => commands.map((command) => command.id ?? ""),
    slashNames: () => commands.flatMap((command) => (command.slash ? [command.slash.name] : [])),
    choose: (value) => {
      nextChoice = value
    },
    selectOptions: () => lastSelectOptions,
  }
}

describe("tui formatting", () => {
  test("formatCount shortens the big numbers", () => {
    expect(formatCount(940)).toBe("940")
    expect(formatCount(77_507)).toBe("77.5k")
    expect(formatCount(2_400_000)).toBe("2.4M")
  })

  test("formatReduction reports what was cut", () => {
    expect(formatReduction(77_507, 15_933)).toBe("79%")
    expect(formatReduction(0, 0)).toBe("")
    expect(formatReduction(10, 20)).toBe("")
  })

  test("summarizeTrace reads as one line", () => {
    const summary = summarizeTrace(
      sampleTrace({
        dedupe: { minContainment: 0.8, dropped: [{ index: 1, url: "u", duplicateOf: 0, reason: "url" }] },
        gate: {
          model: "jev-latest",
          endpoint: DEFAULT_GATE_ENDPOINT,
          thresholds: resolveGateThresholds(),
          questions: {},
          decisions: [
            { index: 0, url: "a", relevant: 1, evidence: 1, injection: 0, kept: true, reason: "kept" },
            { index: 1, url: "b", relevant: 0, evidence: 0, injection: 0, kept: false, reason: "irrelevant" },
          ],
          durationMs: 150,
          usage: {},
          flagged: true,
        },
        trim: {
          threshold: 0.5,
          questions: {},
          passagesTotal: 40,
          passagesKept: 23,
          charsBefore: 77_507,
          charsAfter: 15_933,
          durationMs: 150,
          usage: {},
        },
      }),
    )

    expect(summary).toContain("8 found")
    expect(summary).toContain("1 duplicate dropped")
    expect(summary).toContain("1 gated out")
    expect(summary).toContain("2 returned")
    expect(summary).toContain("77.5k→15.9k chars (79% cut)")
  })

  test("a failure is named in the summary and raises the variant", () => {
    const trace = sampleTrace({
      gate: {
        model: "jev-latest",
        endpoint: DEFAULT_GATE_ENDPOINT,
        thresholds: resolveGateThresholds(),
        questions: {},
        decisions: [],
        durationMs: 0,
        usage: {},
        failed: "HTTP 500",
      },
    })
    expect(summarizeTrace(trace)).toContain("gate failed")
    expect(toastVariant(trace)).toBe("warning")
    expect(toastVariant(sampleTrace())).toBe("info")
  })


  test("renderTrace shows the questions jev was asked", () => {
    const request = buildGateRequest("q", [{ url: "https://a.example", title: "A", content: "a", time: {} }])
    const trace = sampleTrace({
      gate: {
        model: "jev-latest",
        endpoint: DEFAULT_GATE_ENDPOINT,
        thresholds: resolveGateThresholds(),
        questions: describeQuestions(request.questions),
        decisions: [
          { index: 0, url: "https://a.example", title: "A", relevant: 0.99, evidence: 0.98, injection: 0.01, kept: true, reason: "kept" },
        ],
        durationMs: 150,
        usage: { inputTokens: 1200 },
        disagreement: 0.2,
      },
    })

    const rendered = renderTrace(trace)
    expect(rendered).toContain("WHAT JEV WAS ASKED")
    expect(rendered).toContain("`results.<key>`")
    expect(rendered).toContain("relevance 0.99")
    expect(rendered).toContain("1,200 jev tokens")
  })

  test("traceView pairs the query with the rendered trace", () => {
    const view = traceView(sampleTrace({ query: "mount fuji height" }))
    expect(view.title).toBe("mount fuji height")
    expect(view.text).toContain("mount fuji height")
  })
})

describe("copyToClipboard", () => {
  test("writes through the renderer and confirms", () => {
    const tui = makeTui()
    expect(copyToClipboard(tui.ctx, "hello")).toBe(true)
    expect(tui.copied).toEqual(["hello"])
    expect(tui.toasts.at(-1)!.variant).toBe("success")
  })

  test("warns instead of throwing when the terminal cannot copy", () => {
    const tui = makeTui()
    tui.ctx.renderer.copyToClipboardOSC52 = () => false
    expect(copyToClipboard(tui.ctx, "hello")).toBe(false)
    expect(tui.toasts.at(-1)!.variant).toBe("warning")
  })
})

describe("wantsToast", () => {
  test("on unless the shared options switch it off", () => {
    expect(wantsToast({})).toBe(true)
    expect(wantsToast({ debug: true })).toBe(true)
    expect(wantsToast({ debug: { toast: true } })).toBe(true)
    expect(wantsToast({ debug: { toast: false } })).toBe(false)
  })
})

describe("explainEmpty", () => {
  const none = { seen: 0, elsewhere: 0 }

  test("names the real cause in each case", () => {
    expect(explainEmpty({}, none)).toContain("switched off")
    expect(explainEmpty({ debug: { metadata: false, file: "/tmp/t.jsonl" } }, none)).toContain("/tmp/t.jsonl")
    expect(explainEmpty({ debug: true }, none)).toContain("no tool results have reached")
    expect(explainEmpty({ debug: true }, { seen: 3, elsewhere: 1 })).toContain("3 tool results reached")
    expect(explainEmpty({ debug: true }, { seen: 3, elsewhere: 1 })).toContain("another project")
  })

  test("traceDestination mirrors the server half's normalization", () => {
    expect(traceDestination({})).toBe("off")
    expect(traceDestination({ debug: true })).toBe("metadata")
    expect(traceDestination({ debug: { toast: false } })).toBe("metadata")
    expect(traceDestination({ debug: { metadata: false, file: "/tmp/t" } })).toBe("file")
    expect(traceDestination({ debug: { metadata: false } })).toBe("off")
  })
})

describe("readTrace", () => {
  test("reads the trace the server half wrote", () => {
    expect(readTrace({ langsearch: sampleTrace() })!.query).toBe("mount fuji height")
  })

  test("ignores metadata that is not ours or not a trace", () => {
    expect(readTrace(undefined)).toBeUndefined()
    expect(readTrace({ provider: "langsearch" })).toBeUndefined()
    expect(readTrace({ langsearch: "nonsense" })).toBeUndefined()
    expect(readTrace({ langsearch: { query: "q" } })).toBeUndefined()
  })
})

describe("tui plugin", () => {
  test("is shaped the way the host checks for", () => {
    expect(typeof tuiPlugin.id).toBe("string")
    expect(tuiPlugin.id.length).toBeGreaterThan(0)
    expect(typeof tuiPlugin.setup).toBe("function")
  })

  test("toasts a summary when a trace arrives", () => {
    const tui = makeTui()
    tuiPlugin.setup(tui.ctx)
    tui.emit({ data: { metadata: { langsearch: sampleTrace() } } })

    expect(tui.toasts).toHaveLength(1)
    expect(tui.toasts[0]!.title).toBe("LangSearch")
    expect(tui.toasts[0]!.message).toContain("8 found")
  })

  test("finds the trace whether the payload is nested or flattened", () => {
    const tui = makeTui()
    tuiPlugin.setup(tui.ctx)
    tui.emit({ data: { metadata: { langsearch: sampleTrace({ query: "nested" }) } } })
    tui.emit({ metadata: { langsearch: sampleTrace({ query: "flat" }) } })

    expect(tui.toasts).toHaveLength(2)
  })

  test("stays quiet for tool results that are not ours", () => {
    const tui = makeTui()
    tuiPlugin.setup(tui.ctx)
    tui.emit({ data: { metadata: { provider: "langsearch" } } })
    tui.emit({ data: {} })
    expect(tui.toasts).toEqual([])
  })

  test("ignores a search from another project", () => {
    const tui = makeTui({}, "/projects/here")
    tuiPlugin.setup(tui.ctx)
    tui.emit({ location: { directory: "/projects/elsewhere" }, data: { metadata: { langsearch: sampleTrace() } } })
    expect(tui.toasts).toEqual([])

    tui.emit({ location: { directory: "/projects/here" }, data: { metadata: { langsearch: sampleTrace() } } })
    expect(tui.toasts).toHaveLength(1)
  })

  test("debug.toast false records the trace without interrupting", async () => {
    const tui = makeTui({ debug: { toast: false } })
    tuiPlugin.setup(tui.ctx)
    tui.emit({ data: { metadata: { langsearch: sampleTrace() } } })
    expect(tui.toasts).toEqual([])

    tui.renderSlots()
    tui.choose(0)
    await tui.run()
    expect(tui.shown).toHaveLength(1)
  })

  test("registers its commands from a rendered slot, not from setup", () => {
    const tui = makeTui()
    tuiPlugin.setup(tui.ctx)
    // `keymap.layer` needs a component owner, so nothing is registered until
    // the host renders the claim.
    expect(tui.commandIds()).toEqual([])
    tui.renderSlots()
    expect(tui.commandIds()).toContain("langsearch.trace")
  })

  test("exposes one slash command rather than a name and an alias", () => {
    const tui = makeTui()
    tuiPlugin.setup(tui.ctx)
    tui.renderSlots()
    // `/langsearch-trace` was an alias of `/langsearch`, so the palette listed
    // the same action twice; only one name should remain.
    expect(tui.slashNames()).toEqual(["langsearch"])
  })

  test("the command opens the recorded searches", async () => {
    const tui = makeTui()
    tuiPlugin.setup(tui.ctx)
    tui.renderSlots()

    tui.emit({ data: { metadata: { langsearch: sampleTrace({ query: "first" }) } } })
    tui.emit({ data: { metadata: { langsearch: sampleTrace({ query: "second" }) } } })

    tui.choose(0)
    await tui.run()
    // Newest first, and the picker's first row is what got opened.
    expect(tui.selectOptions()[0]!.title).toBe("second")
    expect(tui.shown).toHaveLength(1)
  })

  test("an empty list says debug is off rather than blaming the search", async () => {
    const tui = makeTui()
    tuiPlugin.setup(tui.ctx)
    tui.renderSlots()
    await tui.run()
    // The failing case from a real session: a search had just run.
    expect(tui.alerts[0]!.message).toContain("switched off")
    expect(tui.alerts[0]!.message).toContain('"debug": true')
  })

  test("an empty list counts what it saw when debug is on", async () => {
    const tui = makeTui({ debug: true })
    tuiPlugin.setup(tui.ctx)
    tui.renderSlots()

    await tui.run()
    expect(tui.alerts[0]!.message).toContain("no tool results have reached this plugin")

    // A tool result that is not ours still tells us events are flowing.
    tui.emit({ data: { metadata: { provider: "langsearch" } } })
    await tui.run()
    expect(tui.alerts[1]!.message).toContain("1 tool result reached this plugin")
  })

  test("a cancelled picker opens nothing", async () => {
    const tui = makeTui()
    tuiPlugin.setup(tui.ctx)
    tui.emit({ data: { metadata: { langsearch: sampleTrace() } } })
    tui.renderSlots()
    tui.choose(undefined)
    await tui.run()
    expect(tui.alerts).toEqual([])
    expect(tui.shown).toEqual([])
  })
})

describe("a malformed trace degrades instead of breaking", () => {
  test("a trace that cannot be serialized is dropped, not forced onto the result", () => {
    const circular = sampleTrace() as SearchTrace & { self?: unknown }
    circular.self = circular

    expect(toJsonSafe(circular)).toBeUndefined()
    // The hook the host awaits must not throw, and must leave the result usable.
    const metadata = annotateToolMetadata({ provider: "langsearch" }, circular)
    expect(metadata).toEqual({ provider: "langsearch" })
  })

  test("the TUI renders a trace whose fields are the wrong shape", () => {
    const broken = {
      ...sampleTrace(),
      dedupe: { minContainment: 0.8, dropped: "not an array" },
      gate: { model: "jev", endpoint: "e", thresholds: {}, questions: { relevant: {} }, decisions: null, usage: {} },
    } as unknown as SearchTrace

    expect(() => summarizeTrace(broken)).not.toThrow()
    expect(() => renderTrace(broken)).not.toThrow()
    expect(renderTrace(broken)).toContain("no duplicates found")
  })

  test("a missing score reads as unknown rather than throwing", () => {
    const decision = { index: 0, url: "u", kept: false, reason: "irrelevant" } as unknown as GateDecision
    expect(describeScores(decision)).toContain("?")
    expect(() => describeDropped(decision)).not.toThrow()
  })
})

describe("parsePublished", () => {
  test("reads the ISO date LangSearch returns", () => {
    expect(parsePublished("2018-09-16T07:08:14.000Z")).toBe(Date.UTC(2018, 8, 16, 7, 8, 14))
  })

  test("an absent or unparseable date is no date, not a very old one", () => {
    expect(parsePublished(null)).toBeUndefined()
    expect(parsePublished(undefined)).toBeUndefined()
    expect(parsePublished("")).toBeUndefined()
    expect(parsePublished("   ")).toBeUndefined()
    expect(parsePublished("not a date")).toBeUndefined()
  })
})

describe("ageInDays", () => {
  const now = Date.UTC(2026, 8, 20)

  test("counts whole days back from now", () => {
    expect(ageInDays(Date.UTC(2026, 8, 20), now)).toBe(0)
    expect(ageInDays(Date.UTC(2026, 7, 21), now)).toBe(30)
    expect(ageInDays(Date.UTC(2018, 8, 16), now)).toBe(2926)
  })

  test("an undated result has no age", () => {
    expect(ageInDays(undefined, now)).toBeUndefined()
    expect(ageInDays(Number.NaN, now)).toBeUndefined()
  })
})

describe("withDateline", () => {
  test("puts the date where the model is certain to read it", () => {
    const published = Date.UTC(2018, 8, 16, 7, 8, 14)
    const [first] = withDateline([{ url: "https://a.example", content: "worth $6,293", time: { published } }])
    expect(first!.content).toBe("Published: 2018-09-16\n\nworth $6,293")
  })

  test("leaves an undated result alone", () => {
    const [first] = withDateline([result("https://a.example", "body")])
    expect(first!.content).toBe("body")
  })

  test("does not stack on a second pass", () => {
    const published = Date.UTC(2026, 0, 2)
    const once = withDateline([{ url: "https://a.example", content: "body", time: { published } }])
    expect(withDateline(once)[0]!.content).toBe(once[0]!.content)
  })
})

describe("formatAge", () => {
  test("uses the largest unit that still reads precisely", () => {
    expect(formatAge(0)).toBe("today")
    expect(formatAge(1)).toBe("1 day old")
    expect(formatAge(45)).toBe("45 days old")
    expect(formatAge(180)).toBe("6 months old")
    expect(formatAge(2926)).toBe("8.0 years old")
  })
})

describe("checks.ts as the source of truth", () => {
  test("every default check is valid", () => {
    expect(() => validateChecks()).not.toThrow()
  })

  test("an id with an underscore is rejected, because it would break the trace", () => {
    // `describeQuestions` splits on the first underscore, so `ai_slop_0` would
    // be grouped under the kind `ai`.
    const bad: Check[] = [{ ...DEFAULT_CHECKS[0]!, id: "ai_slop" }]
    expect(() => validateChecks(bad)).toThrow(/invalid check id/)
  })

  test("a duplicate or reserved id is rejected", () => {
    expect(() => validateChecks([DEFAULT_CHECKS[0]!, DEFAULT_CHECKS[0]!])).toThrow(/duplicate/)
    expect(() => validateChecks([{ ...DEFAULT_CHECKS[0]!, id: "passage" }])).toThrow(/reserved/)
  })

  test("bounds that nothing can satisfy are rejected", () => {
    const impossible: Check[] = [{ ...DEFAULT_CHECKS[0]!, keep: { min: 0.8, max: 0.2 } }]
    expect(() => validateChecks(impossible)).toThrow(/nothing can pass/)
    expect(() => validateChecks([{ ...DEFAULT_CHECKS[0]!, keep: { min: 4 } }])).toThrow(/between 0 and 1/)
  })

  test("only enabled checks are asked", () => {
    expect(checksOf("result").map((c) => c.id)).toEqual(["injection", "relevant"])
    const off: Check[] = [{ ...DEFAULT_CHECKS[0]!, enabled: false }]
    expect(checksOf("result", off)).toEqual([])
  })

  test("the thresholds the trace reports come from the file", () => {
    const checks = DEFAULT_CHECKS.map((c) => (c.id === "relevant" ? { ...c, keep: { min: 0.9 } } : c))
    expect(resolveGateThresholds({ checks }).minRelevance).toBe(0.9)
    // A plugin option still wins, so existing configs are unaffected.
    expect(resolveGateThresholds({ checks, minRelevance: 0.2 }).minRelevance).toBe(0.2)
  })
})

// Defined here, not shipped: the mechanism is tested without the package
// carrying a check whose thresholds nobody has calibrated.
const PAYWALL: Check = {
  id: "paywall",
  scope: "result",
  why: "Is the body a subscribe prompt rather than the article?",
  instructions: "Is `results.<key>` mostly a prompt to subscribe or log in, rather than the article itself?",
  criteria: {
    true: "It is mostly a subscription or login prompt",
    false: "It is the article text",
  },
  keep: { max: 0.5 },
}

describe("adding a check", () => {
  const withPaywall = [...DEFAULT_CHECKS, PAYWALL]
  const two = [result("https://a.example/1", "one"), result("https://b.example/2", "two")]

  test("is asked once per result, with no other change", () => {
    const request = buildGateRequest("q", two, { checks: withPaywall })
    expect(request.questions.paywall_0!.instructions).toContain("results.r0")
    expect(request.questions.paywall_1!.instructions).toContain("results.r1")
    expect(describeQuestions(request.questions).paywall!.asked).toBe(2)
  })

  test("drops a result under its own reason, and records its score", async () => {
    stubFetch(() =>
      systemOneResponse({
        relevant_0: 0.9, evidence_0: 0.9, injection_0: 0.01, paywall_0: 0.05,
        relevant_1: 0.9, evidence_1: 0.9, injection_1: 0.01, paywall_1: 0.95,
      }),
    )
    const outcome = await runGate("q", two, { apiKey: "k", checks: withPaywall })
    expect(outcome.results.map((r) => r.url)).toEqual(["https://a.example/1"])
    const dropped = outcome.decisions[1]!
    expect(dropped.reason).toBe("paywall")
    expect(dropped.scores!.paywall).toBe(0.95)
    // The result was otherwise perfect: only the new check removed it.
    expect(dropped.relevant).toBe(0.9)
  })

  test("the shipped list asks nothing extra", () => {
    const off = buildGateRequest("q", two)
    expect(Object.keys(off.questions).some((k) => k.startsWith("paywall"))).toBe(false)
  })
})

describe("bun run checks", () => {
  test("prints each question, what it costs and what it does", () => {
    const text = formatChecks()
    expect(text).toContain("2 per result, 0 per search")
    expect(text).toContain("A search over 5 results therefore asks 10 questions")
    expect(text).toContain("keep the result when score >= 0.45")
    expect(text).toContain("keep the result when score <= 0.5")
    for (const check of DEFAULT_CHECKS) expect(text).toContain(check.instructions)
  })

  test("marks a disabled check as disabled", () => {
    expect(formatCheck({ ...DEFAULT_CHECKS[0]!, enabled: false })).toContain("(disabled)")
  })

  test("a check with no bounds says it only records", () => {
    expect(formatCheck({ ...DEFAULT_CHECKS[0]!, keep: undefined })).toContain("never used to drop anything")
  })
})

describe("describeScores", () => {
  test("reports exactly the checks that were asked, in the order asked", () => {
    const decision = {
      index: 0, url: "https://a.example", relevant: 0.9, evidence: 0.9, injection: 0.1,
      scores: { relevant: 0.9, evidence: 0.9, injection: 0.1, slop: 0.87 },
      kept: false, reason: "slop",
    }
    expect(describeScores(decision)).toBe("relevance 0.90 · evidence 0.90 · injection 0.10 · slop 0.87")
  })

  test("a disabled check is absent rather than reported as zero", () => {
    const decision = {
      index: 0, url: "https://a.example", relevant: 0.9, evidence: 0, injection: 0.1,
      scores: { relevant: 0.9, injection: 0.1 },
      kept: true, reason: "kept",
    }
    expect(describeScores(decision)).toBe("relevance 0.90 · injection 0.10")
    expect(describeScores(decision)).not.toContain("evidence")
  })

  test("falls back to the three fields for a decision recorded before scores existed", () => {
    expect(
      describeScores({ index: 0, url: "u", relevant: 0.5, evidence: 0.4, injection: 0.3, kept: true, reason: "kept" }),
    ).toBe("relevance 0.50 · evidence 0.40 · injection 0.30")
  })
})

describe("which failure is reported", () => {
  const two = [result("https://a.example/1", "one"), result("https://b.example/2", "two")]

  test("an injection attempt is reported as one even when it is also off topic", async () => {
    // The checks are asked in file order, which puts `relevant` first. A page
    // that fails both must still be reported as an injection attempt: that is
    // the security-relevant fact, and it must not depend on list order.
    stubFetch(() =>
      systemOneResponse({
        relevant_0: 0.01, evidence_0: 0.01, injection_0: 0.99,
        relevant_1: 0.9, evidence_1: 0.9, injection_1: 0.01,
      }),
    )
    const outcome = await runGate("q", two, { apiKey: "k" })
    expect(outcome.decisions[0]!.reason).toBe("injection")
  })

  test("precedence, not file order, decides", () => {
    const reordered = byPrecedence(checksOf("result"))
    expect(reordered[0]!.id).toBe("injection")
    // Precedence holds even if the file is reordered.
    const shuffled = [...DEFAULT_CHECKS].reverse()
    expect(byPrecedence(checksOf("result", shuffled))[0]!.id).toBe("injection")
  })
})

describe("a broken checks file", () => {
  test("fails the plugin load rather than silently disabling the gate", async () => {
    // Thrown from `setup`, not from the search path: the gate's fail-open
    // handler would have swallowed it and returned ungated results.
    const { ctx } = makeContext({
      apiKey: "k",
      gate: { apiKey: "typesafe", checks: [{ ...DEFAULT_CHECKS[0]!, id: "ai_slop" }] },
    })
    await expect(plugin.setup(ctx as never)).rejects.toThrow(/invalid check id/)
  })

  test("a valid file loads and registers the provider", async () => {
    const { ctx, editor } = makeContext({ apiKey: "k", gate: { apiKey: "typesafe" } })
    await plugin.setup(ctx as never)
    expect(editor.added).toHaveLength(1)
  })

  test("nothing is validated when the gate is off, because nothing is asked", async () => {
    // `checksOf` is only reachable through the gate, so a broken file cannot
    // break a plain search.
    const { ctx, editor } = makeContext({ apiKey: "k" })
    await plugin.setup(ctx as never)
    expect(editor.added).toHaveLength(1)
  })
})

describe("disabling a default check", () => {
  const without = DEFAULT_CHECKS.filter((c) => c.id !== "relevant")
  const two = [result("https://a.example/1", "one"), result("https://b.example/2", "two")]

  test("stops it being asked", () => {
    const request = buildGateRequest("q", two, { checks: without })
    expect(Object.keys(request.questions).some((k) => k.startsWith("relevant"))).toBe(false)
  })

  test("stops the trace claiming a threshold that was never applied", () => {
    expect(resolveGateThresholds({ checks: without }).minRelevance).toBeUndefined()
    expect(resolveGateThresholds().minRelevance).toBe(0.45)
  })

  test("stops it being recorded as a flat zero", async () => {
    stubFetch(() =>
      systemOneResponse({ injection_0: 0.01, injection_1: 0.01 }),
    )
    const outcome = await runGate("q", two, { apiKey: "k", checks: without })
    expect(outcome.decisions[0]!.scores).toEqual({ injection: 0.01 })
    expect(outcome.results).toHaveLength(2)
  })
})

describe("the pipeline reflects what actually ran", () => {
  const base = {
    query: "q",
    startedAt: "2026-09-20T00:00:00.000Z",
    found: 8,
    returned: 4,
    searchMs: 2000,
    totalMs: 2500,
    stages: {
      found: { items: 8, chars: 12000 },
      returned: { items: 4, chars: 3000 },
    },
  } as SearchTrace

  test("a search on its own is one stage", () => {
    const rows = stageRows(base)
    expect(rows.map((r) => r.name)).toEqual(["search"])
  })

  test("no duplicate-filter row when the filter did not run", () => {
    expect(stageRows(base).some((r) => r.name === "duplicate filter")).toBe(false)
    const withDedupe = { ...base, dedupe: { minContainment: 0.8, dropped: [] } }
    expect(stageRows(withDedupe).map((r) => r.name)).toEqual(["search", "duplicate filter"])
  })

  test("stages are numbered by what ran, not by a fixed list", () => {
    const withGate = {
      ...base,
      gate: {
        model: "jev-latest",
        endpoint: DEFAULT_GATE_ENDPOINT,
        thresholds: resolveGateThresholds(),
        questions: {},
        decisions: [
          { index: 0, url: "https://a.example", relevant: 0.9, evidence: 0, injection: 0.01, kept: true, reason: "kept" },
          { index: 1, url: "https://b.example", relevant: 0.1, evidence: 0, injection: 0.01, kept: false, reason: "irrelevant" },
        ],
        durationMs: 200,
        usage: { inputTokens: 3000 },
      },
    } as SearchTrace
    // The gate is stage 2 without dedupe and stage 3 with it.
    expect(stageRows(withGate).find((r) => r.name === "jev gate")!.n).toBe(2)
    const both = { ...withGate, dedupe: { minContainment: 0.8, dropped: [] } }
    expect(stageRows(both).find((r) => r.name === "jev gate")!.n).toBe(3)
  })

  test("a failed stage says so instead of showing a clean transition", () => {
    const failed = {
      ...base,
      gate: {
        model: "jev-latest",
        endpoint: DEFAULT_GATE_ENDPOINT,
        thresholds: resolveGateThresholds(),
        questions: {},
        decisions: [],
        durationMs: 30,
        usage: {},
        failed: "HTTP 500",
      },
    } as SearchTrace
    const text = renderPipeline(failed).join("\n")
    expect(text).toContain("FAILED: HTTP 500")
    expect(text).toContain("passed through unchanged")
  })

  test("a check added to checks.ts appears as its own drop reason, with no change here", () => {
    // `dropsByReason` reads the reason recorded on each decision, and that
    // reason is the check's id. Nothing in the renderer knows the check names.
    const decisions = [
      { index: 0, url: "u", relevant: 0.9, evidence: 0, injection: 0.01, kept: true, reason: "kept" },
      { index: 1, url: "u", relevant: 0.1, evidence: 0, injection: 0.01, kept: false, reason: "irrelevant" },
      { index: 2, url: "u", relevant: 0.9, evidence: 0, injection: 0.99, kept: false, reason: "injection" },
      { index: 3, url: "u", relevant: 0.9, evidence: 0, injection: 0.01, kept: false, reason: "paywall" },
      { index: 4, url: "u", relevant: 0.9, evidence: 0, injection: 0.01, kept: false, reason: "paywall" },
    ]
    expect(dropsByReason(decisions)).toEqual([
      ["paywall", 2],
      ["irrelevant", 1],
      ["injection", 1],
    ])
  })

  test("the end-to-end reduction is search output versus what the model read", () => {
    const text = renderPipeline(base).join("\n")
    expect(text).toContain("8 results / 12.0k chars")
    expect(text).toContain("4 results / 3.0k chars")
    expect(text).toContain("75% less text reaches the model")
  })
})

describe("pipeline formatting helpers", () => {
  test("shortChars and shortMs stay readable", () => {
    expect(shortChars(940)).toBe("940")
    expect(shortChars(12318)).toBe("12.3k")
    expect(shortChars(undefined)).toBe("?")
    expect(shortMs(221)).toBe("221ms")
    expect(shortMs(2438)).toBe("2.4s")
  })

  test("hostOf strips the scheme and www", () => {
    expect(hostOf("https://www.unilad.com/news/politics/x")).toBe("unilad.com")
    expect(hostOf("https://en.wikipedia.org/wiki/Mars")).toBe("en.wikipedia.org")
    expect(hostOf(42)).toBe("?")
  })

  test("shortTitle keeps one terminal line", () => {
    expect(shortTitle("short", "u")).toBe("short")
    expect(shortTitle("x".repeat(100), "u")).toHaveLength(72)
    expect(shortTitle(undefined, "https://a.example")).toBe("https://a.example")
  })
})

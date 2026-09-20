import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { GateDecision, SearchTrace } from "./index.js"

/**
 * The TUI half of the plugin.
 *
 * OpenCode loads a plugin package twice: the `.` entrypoint in the server,
 * where the search runs, and this one in the TUI, where the user is. They do
 * not share memory, so the server half attaches its trace to the websearch
 * tool result's `metadata` and this half reads it back off the
 * `session.tool.success` event. Nothing is sent to the model in either
 * direction.
 *
 * This half renders JSX for one thing only: the trace viewer. The host's
 * promise-based `dialog.alert` draws its message in a single, unscrollable
 * `<text>`, which is unusable for a trace that can run to dozens of lines. A
 * custom `dialog.show` gives the viewer a `<scrollbox>` and a key handler, so
 * the trace can be scrolled and copied.
 *
 * `@opentui/solid` and the JSX runtime it pulls in are imports the host
 * rewrites at load time to its own bundled instances (its runtime plugin maps
 * those specifiers to virtual modules), so a plugin never ships a second copy
 * of Solid or OpenTUI. `solid-js` is a peer of `@opentui/solid` and is declared
 * with it; none of them are bundled. See the `--external` flags in
 * `package.json`.
 */

/** How many traces are kept for the trace browser. */
export const RECENT_LIMIT = 20

/**
 * Structural types for the host context, mirroring `@opencode/plugin/tui`
 * (verified against opencode v2.0.10).
 *
 * Written out rather than imported so the package's *declarations* pull in no
 * TUI toolkit and so the tests can build a fake context without a renderer.
 * The host only checks that the default export has an `id` and a `setup`; the
 * JSX itself is confined to the internal `TraceDialog`, and the host rewrites
 * its `@opentui/*` imports to its own runtime.
 */
export interface TuiToastOptions {
  title?: string
  message: string
  variant?: "info" | "success" | "warning" | "error"
  duration?: number
}

export interface TuiSelectOption<Value> {
  title: string
  value: Value
  description?: string
  footer?: string
}

/**
 * The slice of OpenTUI's `CliRenderer` this half uses. Written structurally so
 * the package's public types do not have to depend on `@opentui/core`.
 */
export interface TuiRenderer {
  /** Copy text through OSC 52. Returns false when the terminal cannot. */
  copyToClipboardOSC52(text: string): boolean
  /** Whether the terminal advertised OSC 52 support. */
  isOsc52Supported?(): boolean
}

export interface TuiContext {
  readonly options: Readonly<Record<string, any>>
  readonly location?: { readonly directory?: string } | undefined
  readonly renderer: TuiRenderer
  readonly ui: {
    readonly toast: { show(options: TuiToastOptions): void }
    readonly dialog: {
      /** Show a custom dialog. `render` returns the dialog body as an element. */
      show(render: () => unknown, onClose?: () => void): void
      /** Set the active dialog's presentation before showing it. */
      set(options: { size?: "medium" | "large" | "xlarge"; centered?: boolean }): void
      /** Close the active dialog. */
      clear(): void
      alert(options: { title: string; message: string }): Promise<void>
      select<Value>(options: {
        title: string
        placeholder?: string
        options: readonly TuiSelectOption<Value>[]
      }): Promise<Value | undefined>
    }
    /**
     * Claims a place in the host's slot tree, returning a function that
     * releases it. `app` is the outermost slot and stays mounted for the whole
     * session, which is what a command layer needs.
     */
    readonly slot: (claim: {
      append: "app"
      render: (input: Record<string, never>) => unknown
    }) => () => void
  }
  readonly keymap: {
    /** Creates a reactive keymap layer owned by the calling component. */
    layer(input: () => {
      mode?: string
      commands?: readonly {
        id?: string
        title?: string
        description?: string
        group?: string
        bind?: false | string
        palette?: true
        slash?: { name: string; aliases?: string[] }
        run: () => void | false | Promise<void>
      }[]
    }): void
  }
  readonly data: {
    readonly on: (
      type: "session.tool.success",
      handler: (event: {
        location?: { directory?: string }
        data?: { metadata?: Record<string, unknown> | undefined }
        /** The envelope carries a `metadata` of its own; see `readTrace`. */
        metadata?: Record<string, unknown> | undefined
      }) => void,
    ) => () => void
  }
}

/**
 * Options this half reads. Both halves are handed the same plugin config, and
 * everything else in it belongs to the server half.
 */
export interface TuiOptions {
  debug?:
    | boolean
    | {
        /**
         * Show a toast for each search. On by default whenever a trace
         * arrives: a trace only arrives when `debug` was turned on already.
         */
        toast?: boolean
        /** Read to explain an empty trace list; the server half owns these. */
        metadata?: boolean
        file?: string
      }
}

/** Whether a toast should be shown, from the shared plugin options. */
export function wantsToast(options: TuiOptions): boolean {
  const debug = options.debug
  if (!debug || debug === true) return true
  return debug.toast !== false
}

/**
 * Where the server half is sending traces, as far as the shared options say.
 *
 * `off` and `file` both mean nothing will ever arrive here, and a user who has
 * just run a search deserves to be told which - "no searches recorded" reads
 * like a broken plugin when the real answer is that it was never switched on.
 * Mirrors `normalizeDebugOption` in the server half. Exported for testing.
 */
export function traceDestination(options: TuiOptions): "off" | "metadata" | "file" {
  const debug = options.debug
  if (!debug) return "off"
  if (debug === true) return "metadata"
  if (debug.metadata !== false) return "metadata"
  return debug.file?.trim() ? "file" : "off"
}

/** One trace, with the moment it reached the TUI. */
export interface RecentTrace {
  trace: SearchTrace
  receivedAt: number
}

/** What the handler has seen, so an empty list can explain itself. */
export interface TraceCounts {
  /** Tool results this plugin was handed, of any tool. */
  seen: number
  /** Of those, how many were dropped as belonging to another project. */
  elsewhere: number
}

/**
 * Why there is nothing to show.
 *
 * Each case points at a different cause: not switched on, switched on but
 * sending elsewhere, no tool results arriving at all, or tool results arriving
 * without a trace on them. Exported for testing.
 */
export function explainEmpty(options: TuiOptions, counts: TraceCounts): string {
  const destination = traceDestination(options)

  if (destination === "off") {
    return (
      "The debug trace is switched off, so nothing has been recorded.\n\n" +
      "Turn it on in the plugin's options and restart OpenCode:\n\n" +
      '  "options": { "gate": true, "debug": true }\n\n' +
      "Searching works exactly as before either way - the trace is only for you, " +
      "and is never sent to the model."
    )
  }

  if (destination === "file") {
    const file = typeof options.debug === "object" ? options.debug.file : undefined
    return (
      "The trace is being written to a file rather than to the search result, " +
      "so there is nothing to browse here.\n\n" +
      (file ? `  ${file}\n\n` : "") +
      'Set "debug": { "metadata": true } as well to browse traces in this view.'
    )
  }

  if (counts.seen === 0) {
    return (
      "The debug trace is on, but no tool results have reached this plugin yet.\n\n" +
      "Run a web search. If searches do run and this stays empty, the plugin's two " +
      "halves are not talking to each other - please report it."
    )
  }

  const elsewhere = counts.elsewhere > 0 ? ` (${counts.elsewhere} from another project, ignored)` : ""
  return (
    `The debug trace is on and ${counts.seen} tool result${counts.seen === 1 ? "" : "s"} ` +
    `reached this plugin${elsewhere}, but none carried a trace.\n\n` +
    "Traces are attached to LangSearch's own searches only, so other tools will not " +
    "appear here. If a LangSearch search ran and produced no trace, please report it."
  )
}

/** `12345` -> `12.3k`. Char counts are the headline number and need to stay short. */
export function formatCount(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** Percentage of `before` that was removed. Empty when nothing was measured. */
export function formatReduction(before: number, after: number): string {
  if (before <= 0 || after > before) return ""
  return `${Math.round(((before - after) / before) * 100)}%`
}

/**
 * The one line a toast carries: what came in, what went out, and anything the
 * user should know about it. Exported for testing.
 */
export function summarizeTrace(trace: SearchTrace): string {
  const parts: string[] = [`${trace.found} found`]

  const droppedCount = list(trace.dedupe?.dropped).length
  if (droppedCount > 0) parts.push(`${droppedCount} duplicate${droppedCount === 1 ? "" : "s"} dropped`)

  if (trace.gate && !trace.gate.failed) {
    const dropped = list<GateDecision>(trace.gate.decisions).filter((decision) => !decision.kept).length
    if (dropped > 0) parts.push(`${dropped} gated out`)
  }

  parts.push(`${trace.returned} returned`)

  if (trace.trim && !trace.trim.failed && trace.trim.charsBefore > 0) {
    const reduction = formatReduction(trace.trim.charsBefore, trace.trim.charsAfter)
    parts.push(
      `${formatCount(trace.trim.charsBefore)}→${formatCount(trace.trim.charsAfter)} chars` +
        (reduction ? ` (${reduction} cut)` : ""),
    )
  }

  parts.push(`${trace.totalMs}ms`)

  if (trace.gate?.flagged) parts.push("sources disagree")
  if (trace.gate?.failed) parts.push("gate failed")
  if (trace.trim?.failed) parts.push("trim failed")

  return parts.join(" · ")
}

/** Warn when something did not work, info when the pipeline ran clean. */
export function toastVariant(trace: SearchTrace): "info" | "warning" {
  return trace.gate?.failed || trace.trim?.failed ? "warning" : "info"
}

/**
 * A score as the trace reports it, or `?` when it is missing.
 *
 * The trace arrives as opaque JSON on a tool result. Everything here runs
 * inside a dialog handler in the TUI process, where a throw is the user's
 * problem, so a malformed field degrades rather than breaks.
 */
function score(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "?"
}

/** Read an array off a trace, or an empty one when it is missing or malformed. */
function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** One line per result: whether jev kept it, why, and the three scores behind that. */
export function describeDecision(decision: GateDecision): string {
  const scores =
    `relevance ${score(decision.relevant)} · ` +
    `evidence ${score(decision.evidence)} · ` +
    `injection ${score(decision.injection)}`
  const age = typeof decision.ageDays === "number" && Number.isFinite(decision.ageDays)
    ? ` · ${formatAge(decision.ageDays)}`
    : ""
  return `${decision.kept ? "kept" : `dropped (${decision.reason})`} · ${scores}${age}`
}

/** A result's age, in the largest unit that still reads precisely. */
export function formatAge(days: number): string {
  const whole = Math.max(0, Math.round(days))
  if (whole === 0) return "today"
  if (whole === 1) return "1 day old"
  if (whole < 60) return `${whole} days old`
  const months = Math.round(whole / 30)
  if (whole < 730) return `${months} months old`
  return `${(whole / 365).toFixed(1)} years old`
}

/** The full text shown when one search is opened. Exported for testing. */
export function renderTrace(trace: SearchTrace): string {
  const lines: string[] = [
    `Query: ${trace.query}`,
    `Started: ${trace.startedAt}`,
    `Search: ${trace.searchMs}ms · total ${trace.totalMs}ms`,
    `Results: ${trace.found} found → ${trace.returned} returned`,
  ]

  if (trace.dedupe) {
    lines.push("", `Duplicate filter (containment >= ${trace.dedupe.minContainment})`)
    const dropped = list<NonNullable<SearchTrace["dedupe"]>["dropped"][number]>(trace.dedupe.dropped)
    if (dropped.length === 0) lines.push("  nothing dropped")
    for (const drop of dropped) {
      const containment = typeof drop.containment === "number" ? ` ${drop.containment.toFixed(3)}` : ""
      lines.push(`  ${drop.url}`, `    ${drop.reason} copy of result ${drop.duplicateOf}${containment}`)
    }
  }

  if (trace.gate) {
    const gate = trace.gate
    lines.push("", `Gate: ${gate.model} at ${gate.endpoint}`)
    if (gate.failed) lines.push(`  FAILED: ${gate.failed}`, "  the unfiltered results were returned")
    lines.push(
      `  thresholds: relevance >= ${gate.thresholds.minRelevance} · ` +
        `evidence >= ${gate.thresholds.minEvidence} · ` +
        `injection <= ${gate.thresholds.maxInjection} · ` +
        `at most ${gate.thresholds.maxResults}`,
    )
    if (typeof gate.thresholds.maxAgeDays === "number") {
      lines.push(
        `  recency: if the query needs current information (>= ${gate.thresholds.minTimely}), ` +
          `drop results older than ${gate.thresholds.maxAgeDays} days`,
      )
    }
    lines.push(`  ${gate.durationMs}ms · ${gate.usage.inputTokens ?? 0} input tokens`)
    if (gate.timely !== undefined) {
      const acted =
        typeof gate.thresholds.minTimely === "number" && gate.timely >= gate.thresholds.minTimely
          ? gate.staleDropped
            ? ` (the query needs current information; ${gate.staleDropped} stale result(s) dropped)`
            : " (the query needs current information; nothing was old enough to drop)"
          : " (the answer does not go stale, so age was ignored)"
      lines.push(`  timeliness: ${score(gate.timely)}${acted}`)
    }
    if (gate.disagreement !== undefined) {
      lines.push(
        `  disagreement: ${score(gate.disagreement)}` +
          (gate.flagged ? " (the model was told the sources disagree)" : " (below the threshold)"),
      )
    }
    for (const decision of list<GateDecision>(gate.decisions)) {
      lines.push(`  ${decision.title ?? decision.url}`, `    ${decision.url}`, `    ${describeDecision(decision)}`)
    }
  }

  if (trace.trim) {
    const trim = trace.trim
    lines.push("", `Passage trimming (keep above ${trim.threshold})`)
    if (trim.failed) lines.push(`  FAILED: ${trim.failed}`, "  the untrimmed results were returned")
    lines.push(
      `  ${trim.passagesKept}/${trim.passagesTotal} passages kept · ` +
        `${trim.charsBefore} → ${trim.charsAfter} chars · ` +
        `${trim.durationMs}ms · ${trim.usage.inputTokens ?? 0} input tokens`,
    )
  }

  const questions = { ...(trace.gate?.questions ?? {}), ...(trace.trim?.questions ?? {}) }
  // Written by the server half, but read here as opaque JSON.
  const names = Object.keys(questions)
  if (names.length > 0) {
    lines.push("", "What jev was asked")
    for (const name of names) {
      const question = questions[name]
      if (!question || typeof question.instructions !== "string") continue
      lines.push(
        `  ${name} (×${question.asked})`,
        `    ${question.instructions}`,
        `    true:  ${question.criteria?.true}`,
        `    false: ${question.criteria?.false}`,
      )
    }
  }

  return lines.join("\n")
}

/**
 * What the trace viewer draws: the query as the heading and the rendered trace
 * as the body. Split from the component so the formatting stays unit-testable
 * without a renderer. Exported for testing.
 */
export function traceView(trace: SearchTrace): { title: string; text: string } {
  return { title: trace.query, text: renderTrace(trace) }
}

/** Props for the scrollable trace viewer. */
interface TraceDialogProps {
  title: string
  text: string
  /** Copies the body and reports whether the terminal accepted it. */
  copy: (text: string) => boolean
  /** Closes the dialog. */
  close: () => void
}

/**
 * The trace viewer.
 *
 * `dialog.alert` draws its message in a single `<text>`, so a trace longer than
 * the dialog simply runs off the screen; this is the same shape as the host's
 * own error-details dialog, with a bounded `<scrollbox>` instead. Pager keys
 * and `j`/`k` scroll, `c` copies, `esc` closes (the host's binding).
 */
function TraceDialog(props: TraceDialogProps) {
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined

  // Leave room for the title, the footer and the dialog's own padding. The
  // dialog is short-lived, so a value read once at open time is enough.
  const maxHeight = Math.max(6, Math.min(dimensions().height - 10, 40))

  const copy = () => {
    props.copy(props.text)
  }

  useKeyboard((key) => {
    switch (key.name) {
      case "c":
        copy()
        break
      case "up":
      case "k":
        scroll?.scrollBy(-1)
        break
      case "down":
      case "j":
        scroll?.scrollBy(1)
        break
      case "pageup":
        scroll?.scrollBy(-20)
        break
      case "pagedown":
        scroll?.scrollBy(20)
        break
      case "home":
        scroll?.scrollTo(0)
        break
      case "end":
        if (scroll) scroll.scrollTo(scroll.scrollHeight)
        break
    }
  })

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text>{props.title}</text>
        <text onMouseUp={props.close}>esc</text>
      </box>
      <scrollbox
        ref={(element) => (scroll = element)}
        maxHeight={maxHeight}
        contentOptions={{ minHeight: 0 }}
        scrollbarOptions={{ visible: true }}
      >
        <text wrapMode="word">{props.text}</text>
      </scrollbox>
      <box flexDirection="row" gap={3}>
        <text onMouseUp={copy}>c copy</text>
        <text>↑/↓ scroll</text>
        <text>esc close</text>
      </box>
    </box>
  )
}

/**
 * Copy text through the renderer's OSC 52 write, warning when the terminal does
 * not support it. Exported for testing.
 */
export function copyToClipboard(ctx: TuiContext, text: string): boolean {
  let copied = false
  try {
    copied = ctx.renderer.copyToClipboardOSC52(text)
  } catch {
    copied = false
  }

  ctx.ui.toast.show(
    copied
      ? { variant: "success", title: "LangSearch", message: "Trace copied to clipboard" }
      : {
          variant: "warning",
          title: "LangSearch",
          message: "This terminal cannot write to the clipboard (no OSC 52); select the text instead.",
        },
  )
  return copied
}

/**
 * Pull a trace out of a tool result's metadata.
 *
 * The event does not name the tool, so the key is the identification: only the
 * server half writes it. Anything that is not shaped like a trace is ignored,
 * so a future host change cannot make the TUI half throw. Exported for testing.
 */
export function readTrace(metadata: Record<string, unknown> | undefined): SearchTrace | undefined {
  const candidate = metadata?.langsearch
  if (!candidate || typeof candidate !== "object") return undefined
  const trace = candidate as Partial<SearchTrace>
  if (typeof trace.query !== "string" || typeof trace.found !== "number") return undefined
  return trace as SearchTrace
}

export default {
  id: "langsearch.tui",
  setup(ctx: TuiContext) {
    const options = (ctx.options ?? {}) as TuiOptions
    // Lost on a plugin reload, which is the right trade for a debug view: no
    // file to grow, nothing to clean up, and the debug file keeps the history
    // that matters.
    const recent: RecentTrace[] = []
    const counts: TraceCounts = { seen: 0, elsewhere: 0 }

    const dispose = ctx.data.on("session.tool.success", (event) => {
      counts.seen++

      // Events from another project's server reach this TUI too.
      const directory = event.location?.directory
      if (directory && ctx.location?.directory && directory !== ctx.location.directory) {
        counts.elsewhere++
        return
      }

      // The tool's metadata is `event.data.metadata`. The envelope has a
      // `metadata` of its own, checked second only so that a host which
      // flattens the payload still works; `readTrace` rejects anything that is
      // not a trace, so looking in both places cannot pick up the wrong thing.
      const trace = readTrace(event.data?.metadata) ?? readTrace(event.metadata)
      if (!trace) return

      recent.unshift({ trace, receivedAt: Date.now() })
      if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT

      if (!wantsToast(options)) return
      ctx.ui.toast.show({
        title: "LangSearch",
        message: summarizeTrace(trace),
        variant: toastVariant(trace),
      })
    })

    const show = async (): Promise<void> => {
      if (recent.length === 0) {
        await ctx.ui.dialog.alert({ title: "LangSearch", message: explainEmpty(options, counts) })
        return
      }

      const chosen = await ctx.ui.dialog.select<number>({
        title: "LangSearch · recent searches",
        placeholder: "Pick a search to inspect",
        options: recent.map((entry, index) => ({
          title: entry.trace.query,
          value: index,
          description: summarizeTrace(entry.trace),
          footer: new Date(entry.receivedAt).toLocaleTimeString(),
        })),
      })
      if (chosen === undefined) return

      const entry = recent[chosen]
      if (!entry) return

      const view = traceView(entry.trace)
      ctx.ui.dialog.set({ size: "large", centered: true })
      ctx.ui.dialog.show(
        () => (
          <TraceDialog
            title={view.title}
            text={view.text}
            copy={(text) => copyToClipboard(ctx, text)}
            close={() => ctx.ui.dialog.clear()}
          />
        ),
        () => {},
      )
    }

    /**
     * The command component.
     *
     * A keymap layer is reactive and owned by the Solid component that creates
     * it, so `keymap.layer` reads the TUI's Keymap context and throws
     * `Keymap.Provider is missing` when it is called from `setup`, which runs
     * outside the component tree. Rendering this into the `app` slot gives it
     * an owner. It draws nothing and returns null.
     */
    const commands = () => {
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "langsearch.trace",
            title: "LangSearch: inspect recent searches",
            description: "Show what jev was asked and which results it kept or dropped",
            group: "LangSearch",
            palette: true,
            slash: { name: "langsearch" },
            run: () => {
              void show()
            },
          },
        ],
      }))
      return null
    }

    const unmount = ctx.ui.slot({ append: "app", render: () => commands() })

    return () => {
      dispose()
      unmount()
    }
  },
}

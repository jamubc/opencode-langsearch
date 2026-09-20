/**
 * Print every question jev is asked.
 *
 * `bun run checks` - the answer to "what is the gate actually doing?" without
 * reading any code. Add `--json` for the machine-readable form.
 */
import { DEFAULT_CHECKS, validateChecks } from "./checks"
import type { Check } from "./checks"

/** One check as it is shown on a terminal. Exported for testing. */
export function formatCheck(check: Check): string {
  const bounds: string[] = []
  if (check.keep?.min !== undefined) bounds.push(`score >= ${check.keep.min}`)
  if (check.keep?.max !== undefined) bounds.push(`score <= ${check.keep.max}`)
  const effect =
    check.scope === "query"
      ? "asked once per search; see checks.ts for what its score drives"
      : bounds.length
        ? `keep the result when ${bounds.join(" and ")}`
        : "recorded in the trace, never used to drop anything"

  return [
    `${check.id}${check.enabled === false ? "  (disabled)" : ""}`,
    `  ${check.why}`,
    `  asked: per ${check.scope}`,
    `  effect: ${effect}`,
    `  Q: ${check.instructions}`,
    ...(check.criteria ? [`     true:  ${check.criteria.true}`, `     false: ${check.criteria.false}`] : []),
  ].join("\n")
}

/** The whole list as it is shown on a terminal. Exported for testing. */
export function formatChecks(checks: readonly Check[] = DEFAULT_CHECKS): string {
  validateChecks(checks)
  const enabled = checks.filter((check) => check.enabled !== false)
  const perResult = enabled.filter((check) => check.scope === "result").length
  const perQuery = enabled.filter((check) => check.scope === "query").length

  return [
    "Questions jev is asked, from src/checks.ts",
    `${enabled.length} enabled: ${perResult} per result, ${perQuery} per search.`,
    `A search over 5 results therefore asks ${perResult * 5 + perQuery} questions in one request.`,
    "",
    checks.map(formatCheck).join("\n\n"),
  ].join("\n")
}

if (import.meta.main) {
  console.log(process.argv.includes("--json") ? JSON.stringify(DEFAULT_CHECKS, null, 2) : formatChecks())
}

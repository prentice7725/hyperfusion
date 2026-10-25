# Evidence retrieval experiment (draft)

Status: experiment tooling only. The read-only `evidence` packet, the
`evidence-search` command and the `buried_defect_detected` comparison field
exist (see [Tooling](#tooling)). Phase 0 measurement, Phase 1 fixtures and any
live trial have not been run, and nothing is approved for rollout. It extends
the existing bounded-packet pattern
([lead view](../scripts/lead-view.mjs), [finding ledger](finding-ledger.md),
[bounded memory recall](memory-recall.md)) and reuses the
[A/B pilot](benchmark-pilot.md) tooling.

## Goal and adoption rule

Reduce the lead's context consumption on long tasks **without** losing defect
evidence. A candidate is adopted only if both hold on paired trials:

- lead input-equivalents per successful task decrease, and
- buried-defect detection, `wrong_closes`, `escaped_regressions` and
  `scope_violations` are equal or better than the current arm.

Fewer tokens with any additional missed defect is a failure. Savings claims
follow the existing rules: incomplete usage, missing pairs or missing guardrail
counts suppress the claim.

## Roles (unchanged authority)

- **Controller** keeps raw test, review and acceptance artifacts and remains the
  only source of approval, CLOSE and redo decisions.
- **Evidence index** is a derived, rebuildable view over those artifacts. Every
  entry points to a raw artifact path, its SHA-256, task ID, round and AC IDs.
  It never stores data that the raw artifacts do not already hold, and it is
  never consulted for a verdict.
- **Lead** receives a compact packet first and opens raw evidence only when the
  packet flags it or the lead suspects a gap.

The index sits beside the finding ledger and memory layer; it replaces neither.

## Push before pull

Query-based retrieval (BM25 or similar) only returns what the lead thinks to
ask for, so it cannot surface unknown risks. The controller therefore always
pushes a fixed set of signals, and search is only a follow-up tool:

Always pushed (never subject to a byte budget cut without an explicit
`omitted` count and pointers):

- failed or unknown acceptance commands, with AC IDs and first failing location
- `environment_failures` and process-shutdown uncertainty
- reviewer verdict disagreements and single-reviewer blocking findings
- acceptance-test change signals and protected-file violations
- declared-versus-actual changed-file mismatches
- truncation markers from any packet

Pulled on demand: surrounding log lines, full reviewer reasoning, passing-test
detail, earlier rounds.

## Phase 0 — measure the bottleneck first

Before building anything, use existing `lead-usage` records (`components`,
`by_role`, `subagent_tokens`) from recent real tasks to estimate how much lead
input comes from reading controller output, review results and logs versus
planning, instructions and cached context. If the readable-evidence share is
small, the upper bound on savings is small and the experiment should stop here.

Deliverable: a short table per task of lead tokens attributable to evidence
reads (approximate; tool-result sizes from the transcript are an estimate, not
billing data).

## Phase 1 — buried-defect fixtures

The ten canonical cases measure success and cost, not whether a lead notices a
buried signal. Add defect-injection variants that keep the same acceptance
contract:

- a single failing assertion in the middle of a long passing test log
- a blocking finding raised by only one of two reviewers, with the other
  approving
- an `environment_error` test reported alongside a `complete` status
- a regression visible only in a log section a summary would compress
- a correct-looking summary whose raw evidence contradicts it

Each variant records whether the lead acted on the planted signal before
CLOSE (`buried_defect_detected: true|false|null`). Unknown stays `null`.

## Phase 2 — arms

Run with `benchmark.mjs compare-repeated`, randomized order, pinned
implementation refs and a stable `protocol_digest` per case.

| Arm | Lead receives |
| --- | --- |
| current | today's compact view and bounded packets |
| push | current + controller-built signal packet above, raw pointers only |
| push+pull | push + a read-only search command over the evidence index |

Start with `--repetitions 1` on the injected variants as a smoke run, then the
default three repetitions. A small sample is not statistical proof.

## Index constraints (push+pull arm only)

- `engines` is `node >=24` and the project has no runtime dependencies. The
  implemented search is a small pure-JS BM25 index rebuilt per call. Built-in
  `node:sqlite` (FTS5) exists on Node 24 but is not yet a stable API; consider
  it only if per-call rebuilding becomes too slow, and never add a native
  dependency for the experiment.
- Index only controller-owned artifacts inside the control folder; apply the
  existing redaction rules before indexing and skip secret paths.
- Store the raw artifact SHA-256 per entry; a mismatch invalidates the entry
  instead of returning stale text.
- Read-only: the search command must not launch models, execute code or change
  task state.

## Tooling

Both commands use the inspection path: no controller lock, no state change, no
file writes, no model launch and no code execution. Their output is marked
`authoritative:false`.

```sh
node scripts/fusion-state.mjs evidence REPO
node scripts/fusion-state.mjs evidence-search REPO QUERY.json
```

`QUERY.json` is `{"query":"empty token","limit":8,"byte_budget":12000,"round":1}`;
only `query` is required. Limits are 1–50 hits and 512–200000 bytes.

- `evidence` returns the push signals for the current round
  (`ACCEPTANCE_NOT_RECORDED`, `ACCEPTANCE_FAILED`, `ACCEPTANCE_SKIPPED`,
  `ACCEPTANCE_NOT_QUIESCENT`, `ACCEPTANCE_TREE_CHANGED`, `OUTPUT_TRUNCATED`,
  `ENVIRONMENT_FAILURE`, `WORKER_REPORTED_TEST_FAILURE`, `WORKER_OPEN_ITEMS`,
  `CHANGED_FILES_MISMATCH`, `ACCEPTANCE_TEST_CHANGED`, `CONTROLLER_ERRORS`,
  `REVIEW_VERDICT_DISAGREEMENT`, `SINGLE_REVIEWER_BLOCKING`,
  `REVIEW_SOURCE_WARNING`, `ARTIFACT_UNREADABLE`, `FINDING_LEDGER_UNAVAILABLE`).
  Artifact-derived signals carry the raw artifact name and SHA-256.
  State-derived controller errors name `/last_errors`, expose their full `count`
  and explicit `omitted` count after the first five displayed errors. More than
  20 signals of one code become an `omitted` count with source pointers. An empty list means no
  recognized signal, not a pass.
- `evidence-search` builds an in-memory BM25 index on every call over
  controller-written results, acceptance, validation, review, lead and revision
  packets and briefs. Dispatch prompts and `state.json` are excluded. Files over
  4 MiB, symlinks and unreadable JSON are listed in `skipped`; aggregate artifact
  content is capped at 32 MiB. Consult results derive their round from a bounded,
  validated consult assignment prompt (matching task, consult, member and assigned
  reviewer for advisor, committee or review mode), rather than the consult number or a result-supplied round. Missing or
  invalid provenance is skipped as `consult_provenance`; voided reviews are skipped.
  Text uses the transport secret patterns and secret-field rules before indexing
  and display, including plain values under `password`, `api_key` and token fields.
  Unsafe field names are skipped as `redaction_unsafe` so their JSON pointers cannot
  leak sensitive text. Raw files, hashes and JSON pointers remain unchanged.
  Multiline masks preserve original newline counts: `lines` addresses the original
  decoded JSON string at that pointer, not physical lines in serialized JSON.
  Index traversal is iterative and bounded to depth 64, 5000 chunks per file and
  20000 chunks per call. A file exceeding depth/chunk limits is skipped atomically
  (`depth_limit`/`chunk_limit`), without retaining partial search evidence.
- `byte_budget` bounds the complete compact UTF-8 JSON response, including query,
  hits, `omitted`, `skipped`, counters and `used_bytes` itself. CLI search emits that
  exact compact JSON without trailing whitespace. Whole hits are never truncated.
  Omitted hits retain file, hash, JSON pointer and line range while space permits.
  Evidence hits take priority over individual omission/skip metadata rows; when
  those rows cannot fit, `metadata_omitted.omitted` and `.skipped` count the missing
  rows. `omitted_count` and `skipped_count` always include both displayed and missing
  rows; `more_matches` separately counts ranked matches beyond `limit`. Increase the
  budget or narrow the query/round to recover more detail. Required response metadata
  that cannot fit (for example a very long query) raises `EVIDENCE_RESPONSE_BUDGET`.
  Nothing is persisted, so there is no stale index to invalidate.
- `benchmark.mjs compare-repeated` reports `defect_detection`
  (`planted`, `detected`, `missed`, `unknown`) per arm from an optional boolean
  `buried_defect_detected` on each trial record. It does not affect
  `guardrails_complete` or any reduction figure.

Known limitation found while building this: acceptance records keep only the
last 4000 characters of each command's output (`output_tail`) plus its byte
count and hash. For a failed command, the runner now also keeps the first
failure-looking line before that tail and up to 19 following lines (at most
2000 characters) as `output_failure_line` and `output_failure_excerpt`.
`ACCEPTANCE_FAILED` shows its first line as `head_failure`, the next-round
acceptance feedback and the lead's `controller_acceptance` context include it,
and `evidence-search` indexes it. The excerpt uses the same text pattern as
`first_failure`; it is supporting evidence, never a verdict. Other lines
before the tail are still not recoverable, and `OUTPUT_TRUNCATED` keeps that
gap visible. Retaining full acceptance output remains a separate storage
decision.

## Context Mode (separate research track)

[Context Mode](https://github.com/mksglu/context-mode) is licensed under
Elastic License 2.0; do not copy its source into this MIT project. Its
`ctx_execute` runs code in the project directory with a denylist-filtered
environment and network access, which is not OS isolation.

The lead guard matches only `Edit|Write|MultiEdit|NotebookEdit` and `Bash`
(`scripts/lead-guard.mjs`), so an MCP execution tool is outside the lead
write guard. Any evaluation must:

- run MCP-only in a disposable environment, with its hooks and auto-routing
  disabled, never in a repository with an active task
- first attempt to reproduce a guard bypass through its execution tool and
  record the result
- not influence controller acceptance, review or CLOSE decisions

Its published 98% figure comes from small selected fixtures in a
summarize-by-script mode; its exact-text search mode reports 44–93%. Neither
is evidence for HyperFusion savings.

## Open questions

- Should the push packet become part of the existing `revision-packet` or a
  separate per-round artifact?
- How is `buried_defect_detected` judged independently of the lead under test?
- Is a lead-facing search command worth its maintenance cost if the push arm
  alone meets the adoption rule?

# Reproducible A/B pilot

## Repeated current-versus-candidate evaluation

After a smoke pilot, compare the current controller with the candidate using
three fresh paired repetitions of each of the ten canonical cases. Both arms use
the existing fixture and measurement-window commands below; do not change their
cutoffs. Run arms sequentially and randomize their order for every pair. The
older host-only comparison remains a separate experiment.

Add `comparison` metadata to each actual metric record:

```json
{"arm":"current","repetition":1,"order":1,"implementation_ref":"v0.26.0","protocol_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cli_versions":"record exact CLI versions","cache_conditions":"cold or describe cache state","quota_timeouts":"none or describe events","human_help":"none or describe assistance"}
```

Use `arm: "candidate"` in the other array and complementary execution order 1/2.
Pin one implementation ref per arm. `protocol_digest` is an operator-computed
lowercase SHA-256 of the approved task, team, exact models/efforts, acceptance
definitions and measurement scope. Keep it stable for each case across arms and
repetitions; retain its source manifest with the experiment. The comparator
checks supplied metadata, not whether the operator actually followed it.

```sh
node scripts/benchmark.mjs compare-repeated CURRENT.json CANDIDATE.json
```

The default expects 30 pairs; `--repetitions` permits 1–10 for bounded experiments.
Duplicate cases/repetitions and invalid arms are rejected. Missing pairs,
incompatible scope/trees/protocols, changing implementation refs, incomplete
usage or missing condition records suppress reduction claims. Raw trial records
and conditions are retained in the report. Failed trials stay in cost numerators.

Record total `provider_cost_usd` only when all providers are covered, `wall_ms`,
and independently checked counts `wrong_closes`, `escaped_regressions` and
`scope_violations` on each trial. Missing values stay unknown. Cost is supplied
observed/estimated data, not a billing verification. `--pricing` retains the
existing component-pricing validation; the lead workload comparison uses reference
input-equivalent units. Missing cost/quality/wall evidence leaves
`guardrails_complete: false` even when all paired usage records exist.

The report never authorizes rollout. Review paired success counts, wrong CLOSEs,
lost evidence, total-provider cost, scope violations and p95 wall time before
considering the plan's provisional targets. A small sample's p95 is unstable;
these repetitions are not statistical proof or live-model evidence by themselves.

This tool records actual paired trials; it does not run agents or claim savings.
The ten canonical fixtures include seven JS/docs cases, two Java cases, and one
Java/Spring MVC case. Java requires JDK 17+, and Spring additionally requires
Maven with authorized dependency access or a prefilled cache. Pinning dependencies
makes the fixture reproducible; it is not a production dependency recommendation.

## Prepare both arms

```sh
node scripts/benchmark.mjs prepare HF-B01 /tmp/hf-baseline-b01
node scripts/benchmark.mjs prepare HF-B01 /tmp/hf-orchestrated-b01
```

Targets must not exist. Each command creates a Git repository from the same
fixture, returns `initial_tree`, `fixture_id`, `brief_file` and baseline status,
and keeps the canonical manifest outside the workspace. Commit dates, line endings
and content are deterministic. `red` means assertion exit 1; toolchain failures,
timeouts and compile failures are `environment-unverified`, never evidence of a bug.

Prefill Java/Maven caches before starting either measurement window. Keep the
acceptance files unchanged. The editable paths are returned in `editable`; the
controller-generated brief includes acceptance commands and `.build/**` artifacts.

## Use the same window in both arms

```sh
node scripts/benchmark.mjs start HF-B01 /tmp/hf-baseline-b01 --arm baseline --session HOST_SESSION_ID
node scripts/benchmark.mjs start HF-B01 /tmp/hf-orchestrated-b01 --arm hyperfusion --session OTHER_HOST_SESSION_ID
```

Use separate host sessions/repositories with the same task prompt and fixture.
Start before planning or implementation. The session argument is the actual Claude
Code session ID, not a made-up benchmark ID; installed host hooks can provide the
binding instead. Run the baseline with the host alone. Initialize the HF arm with
the generated brief and task ID `HF-B01`. Do not run both arms simultaneously in
one host turn. CLI/config differences and human assistance must be recorded by the
operator; the tool cannot prove experimental equality beyond its recorded inputs.

```sh
node scripts/benchmark.mjs stop HF-B01 /tmp/hf-baseline-b01 --success --session HOST_SESSION_ID --transcript /absolute/session.jsonl
node scripts/benchmark.mjs stop HF-B01 /tmp/hf-orchestrated-b01 --success --session OTHER_HOST_SESSION_ID --transcript /absolute/other.jsonl
```

Use `--failed` for failed/budget-exhausted trials, retaining their usage. Baseline
success must pass controller-run acceptance, including process shutdown proof.
Unknown shutdown leaves an acceptance lock. Confirm all related processes stopped,
then run `benchmark.mjs recover CASE REPO --quiescent --reason "confirmed shutdown"`
to record the operator confirmation and clear only that benchmark lock. Never rerun
automatically. The HF result must match
CLOSE/BLOCKED. Changed acceptance fixtures, active writers, dirty initial trees and
reused measurement windows are rejected. Both benchmark arms end at the explicit
stop command: hook latency cannot add later messages to either arm. The final host
Stop can refresh streamed usage for API messages already in that window, so export
metric records after that Stop. Ordinary HF task windows still include the closing
summary; benchmark windows intentionally use the same command cutoff. No transcript
path/text or raw session ID is saved. A manually stopped window cannot be restarted;
prepare a fresh repository for another trial.

The resulting records include `case_id`, `initial_tree`, `fixture_id` and the shared
`benchmark-window` scope. Collect ten records into each JSON array, then compare:

```sh
node scripts/benchmark.mjs compare BASELINE.json HYPERFUSION.json
node scripts/benchmark.mjs compare BASELINE.json HYPERFUSION.json --pricing PRICES.json
```

## Large suite (historical feature commits)

The ten core cases are single-file fixtures that Opus finishes alone in a few
turns, so they cannot show where delegation pays off. The `large` suite
(`references/benchmark-large-cases.json`, `HF-L01`–`HF-L05`) rebuilds real
HyperFusion feature commits: the tree just before the commit plus that commit's
tests, with no Git history, `.claude/` or `.github/`. The brief carries the
commit's behaviour as AC1…ACn, the editable paths, and the commit's test file as
the acceptance command. Everything under `tests/` is protected.

```sh
node scripts/benchmark.mjs cases --suite large
node scripts/benchmark.mjs prepare HF-L01 /tmp/hf-l01-base --source /path/to/hyperfusion-clone
node scripts/benchmark.mjs compare BASELINE.json HYPERFUSION.json --suite large
```

`--source` (or `HF_BENCHMARK_SOURCE`) must be a full clone that contains the
source commit; an installed copy that is itself a full clone works without it.
CI checkouts are shallow, so the shipped cases are not prepared in CI. Each
acceptance run uses the case's `acceptance_timeout_ms` (300 s), and the
reference commit of every shipped case passes its acceptance file on Windows in
6–82 s.

Calibrate before comparing. Run the baseline arm once per case and keep a case
only when Opus alone spends at least 150k reference lead input-equivalents or 10
turns. A lighter case cannot show a delegation benefit and is dropped or
replaced. Calibration runs are not comparison trials; prepare fresh fixtures for
the paired runs. `compare --suite large` and `compare-repeated --suite large`
expect only large-suite records and never mix them with the core suite.

### Quality scoring with hidden tests

The protected acceptance file is the commit's own test, and both arms see it. A
pass therefore shows that the trial meets what that file checks, not that it
meets every item the brief names. Hidden tests close that gap. They live outside
the repository, by default in `~/.hyperfusion/benchmark-hidden/<CASE>/*.test.mjs`
(override with `--hidden` or `HF_BENCHMARK_HIDDEN`). The installed skill is a Git
clone of this repository, so a lead or worker could read tests stored here.

Write hidden tests only for items the brief's criteria name and the acceptance
file does not exercise. Use only names the acceptance file already fixes, and
assert behaviour the brief states, not choices the brief leaves open (which
artifact a signal cites, how many omitted pointers fit a tight budget). A hidden
test runs at `tests/hidden/` in a copy of the trial tree, so it imports
`../../scripts/...`.

```sh
node scripts/benchmark.mjs check-hidden HF-L01 --source /path/to/hyperfusion-clone
node scripts/benchmark.mjs score HF-L01 /path/to/trial-repo [--regressions] [--record]
```

`check-hidden` builds the reference commit and its parent tree and runs the
hidden tests on both. They are valid only when every test passes on the
reference and the parent fails. `score` copies the trial's final tree (tracked
plus untracked, minus ignored files and `.hf-tmp/`) and runs the hidden tests
there. It reports scope violations: changed files outside the case's editable
paths. With `--regressions` it also runs the existing test files that reach a
changed file through static imports. A file that fails at the end is rerun on
the start tree. A test that fails at the end and passed there by the same name
is an escaped regression, even inside a file that already failed for another
reason. A file that crashes at the end without naming a test counts when it
passed on the start tree.
Test files run one at a time on Windows, as in `npm test`. Affected files often
cover most of the suite, so this can take as long as a full serial run.
`--record` writes `wrong_closes` (a CLOSE whose hidden tests or regressions
fail), `scope_violations` and, when checked, `escaped_regressions` into the
trial's metric record for `compare-repeated`. Scoring never writes into the
trial tree.

## Usage and price assumptions

Raw `lead_tokens` remains available. `components`, `by_model`, `by_role` and
`subagent_tokens` expose how it was accumulated; host subagents are included once.
The reference input-equivalent weights are input 1, output 5, cache read 0.1 and
cache creation 1.25. These are fixed workload assumptions supplied for comparison,
not live prices or billed dollars. Without pricing, the primary metric is reference
lead input-equivalents per successful task, and different host model sets are refused.

For cost comparison, supply an explicit USD-per-million table for every observed
Claude model (host and workers), with source/date:

```json
{
  "source": "operator-verified pricing source",
  "as_of": "2026-10-14",
  "models": {
    "YOUR_ACTUAL_CLAUDE_MODEL": {
      "input_tokens": 1,
      "output_tokens": 5,
      "cache_read_input_tokens": 0.1,
      "cache_creation_input_tokens": 1.25
    }
  }
}
```

The numbers above are illustrative, not provider prices. With that profile, the
primary metric is estimated **total Claude USD per successful task**, including
host subagents, implementation, review, consultation and failed trials. Unknown
components/model prices or differing trees/scopes make the comparison incomplete;
no reduction is claimed. Cache durations, discounts and actual billing can differ
from this estimate. External provider costs, success rates, regressions, wall time
and human assistance remain separate guardrails. A ten-case pilot is not statistical
proof. No live pilot or actual savings has been measured by this change.


HyperFusion task metrics also record `controller_ended_at`, the time the controller reached
CLOSE or BLOCKED. `ended_at` is when the measurement window closed. The gap between them is
time the lead session stayed open after the task ended, such as a headless `claude -p`
waiting on a scheduled wakeup. Report wall time to `controller_ended_at` alongside
wall time to `ended_at`. Baseline metrics leave it `null`.

## Automation observation coverage (HF-I01)

Task metrics and `compare` summaries include `automation`. `observed_tasks` and
`eligibility_checked_tasks` define the coverage of `eligible_tasks` and
`actually_automated_tasks`; a grant alone is not proof of eligibility or approval.
`stopped_tasks_by_reason` counts each task once per reason, while individual task
metrics retain stop event counts across separate autopilot invocations.

`transport_by_role_model_effort` counts create-once launch markers, including
failed attempts; it is not a provider invocation or host-model call count.
`host_model_invocations` remains null. Review seat milliseconds sum transports;
`review_wait_ms` takes the union of observed review intervals, so parallel seats
are not counted twice. Grok xhigh review seat time is separate. Missing duration
or start evidence suppresses the corresponding complete timing total.

`autopilot_phase_ms` covers complete, nonoverlapping journal windows only. It does
not measure manual lead wait or time outside autopilot. Old or interrupted
journals suppress a complete phase total. Re-run `metrics.mjs REPO` after manual
settlement to refresh evidence. Baseline host-only windows have no controller
observations. Existing measurement window, fixture and failed-trial cost rules
are unchanged; no new task-init grants are added by observation or comparison.

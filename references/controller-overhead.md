# Controller overhead tools

These optional tools inspect the existing controller. They do not initialize tasks,
write state, launch models, run acceptance commands or confer approval authority.

## Measure local inspection time

```sh
node tools/profile-controller.mjs REPO --repetitions 3
node tools/profile-controller.mjs REPO --repetitions 3 --state STATE.json --task-dir TASK_DIR
```

The first form measures `snapshot` and `ignoredManifest`; the second also measures
`findingLedger` using explicit existing controller artifacts. Output includes every
sample's actual monotonic elapsed milliseconds and counts, plus minimum, median and
maximum time. No warm-up samples are discarded. Snapshots and approval evidence are
never cached or returned for reuse. Git inspection uses the controller's existing
safe Git wrapper; repository hooks and supplied commands are not executed.

Repetitions are limited to 1–10. Optional state input is a regular JSON file up to
1 MiB; the task directory may contain up to 10000 ordinary files, up to 4 MiB each
and 32 MiB total. Symlink artifacts are refused. Existing snapshot and ignored-file
limits remain unchanged; the tool does not interrupt an individual synchronous
operation. Inspect a settled task for reproducible comparisons. Filesystem caches,
machine load and concurrent changes affect timings. Counts help detect different
workloads; samples are not acceptance or runtime eligibility evidence. Model time,
token usage and live-task savings are outside this measurement.

The ledger now inventories directory names once per call and indexes resolution
filenames by finding ID. It preserves sorted annotation selection, raw observations
and per-call validation of resolution hashes, current round and acceptance/review
evidence. This removes repeated directory scans without caching any decision.

A same-fixture local comparison on Linux / Node 24.22.1 used one review with
250 distinct findings, 40 stale resolution annotations and 1000 unrelated resolution
files (1041 files total). Seven alternating before/after runs, with no samples
removed, produced identical complete ledger output: 250 issues, 250 observations,
one source and 40 warnings. Directory inventories fell from 251 to 1. Median local
ledger time was 155.46 ms before and 3.83 ms after (ranges 151.02–174.61 ms and
3.04–5.38 ms). This synthetic observation establishes the directory-scan effect;
it does not measure model savings or end-to-end task latency.

## Prepare a brief

Start with one of these illustrative contracts and adapt its task ID, literal
paths, criteria and commands to the actual repository:

- [Bugfix](brief-examples/bugfix.json): a prepared failing regression contract.
- [Preserve/refactor](brief-examples/preserve.json): existing passing behavior,
  protected tests and an explicit reason for the green baseline.
- [New feature](brief-examples/new-feature.json): a prepared failing feature contract.

The test files in these examples are placeholders for real, independently prepared
contract tests. The examples do not create those files. They carry no delegation
or implementation grants; the lead chooses any existing authorization separately.
Preserve tasks use `task_kind:"refactor"`. Existing delegated preserve policy still
requires an explicit `allow_preserve:true`; this tool adds no exception.

```sh
node tools/preflight-brief.mjs REPO BRIEF.json
```

This reads static repository configuration and a regular JSON brief up to 1 MiB.
On cloned inputs it calls the same `takeAssignment`, `takeDelegation`,
`takeRedoDelegation` and brief contract validation used by the controller. It emits
the completed checks, the first failure if any and an explicit list of unchecked
conditions. Exit 0 means those static checks passed; exit 1 means invalid input.
It does not emit assignment/delegation records or normalized input for dispatch.

It does **not** run `init`, probe an executor CLI, test routing availability, inspect
project/workflow or existing task state, match protected files, measure a baseline,
prove process shutdown or evaluate approval eligibility. A passing static check is
not a claim that the controller will accept or execute the task. The controller
still performs its complete checks when the lead explicitly starts the task.

# Experimental isolated parallel implementation (HF-I06, unreleased)

Serial implementation remains the default. A **new project proposal** can opt in
before user approval with this top-level field:

```json
{"parallel_implementation":{"slots":2,"reason":"Explicit independent-task pilot; measure wall time and total cost before rollout"}}
```

Approval freezes this policy with the workflow. An active plan cannot acquire it
through configuration edits or amendments. There is no automatic rollout or
measured speedup claim. Use the repeated benchmark before wider adoption.

## Plan and prepare independent work

Use `workspace:"isolated"` on each child. Keep scopes disjoint, including parent
directories and case-insensitive aliases. Disjoint files alone do not establish
semantic independence: encode interfaces, generated files, locks and migrations
as dependencies. Each child needs its existing shared `integrates:"CHILD_ID"`
task, covering the child scope and acceptance commands. Parallel plans also need
a shared **join task** in the same milestone whose `depends_on` includes every
isolated child and whose scope/commands cover them all. This task verifies the
combined tree through existing acceptance, cumulative review and CLOSE. Use the
existing explicit green baseline or preserve contract if join tests already pass.

```sh
node scripts/worktree.mjs create REPO child-a
node scripts/worktree.mjs create REPO child-b
```

At most two isolated tasks can be reserved/active. Reservations consume slots.
Overlapping scopes, active shared work, missing dependencies and full slots block
claims. Prepare all worktrees in a cohort before any task becomes active; creating
worktrees during an active implementation is refused to avoid shared Git changes.

Preparation starts from explicit Git HEAD and copies Git-listed parent source,
including uncommitted integrated upstream changes. Contents and modes are checked
against the parent snapshot. Ignored guard files and secrets are not copied; a
remaining source-identity mismatch stops preparation. Links, unsupported paths and
oversized changed files are refused. Failed preparation preserves the detached
workspace/manifest for inspection without granting a reservation. No commits,
staging, reset or automatic cleanup are implied.

Use existing init/begin/bridge commands in each workspace. Parent controller locks
serialize metadata transitions; writers keep independent workspace leases and
process supervision. Init and begin check parent source identity. This supplies
bounded concurrent execution support, not an automatic multi-project launcher.
Existing task budgets, shutdown proof and checkpoints remain mandatory.

Shared integration waits for active/reserved work to settle. Child CLOSE leaves
it `awaiting_integration`; ordinary dependents wait for verified integration.

## Export and explicitly apply reviewed content

After child controller CLOSE with no writer, consultation or uncertain acceptance:

```sh
node scripts/worktree.mjs bundle REPO child-a
```

The immutable bundle binds the frozen plan, baseline, reviewed digest, file modes,
before/after identities and content. Limits are 200 regular files and 8 MiB of
changed content. Binary content, additions and deletions need no patch drivers;
symlinks are refused.

Init/begin the approved shared integration task, reserving its writer lease.
**Apply is a controller operation before running that round's bridge.** Any
existing launch or process marker refuses application, even if a worker may have
already exited. It must never mutate alongside a live or uncertain worker.
Explicit controller access and the current reserved lease token are required;
this command grants neither and cannot be called by an already-launched worker.

Pass an input JSON file containing that lease `token`, the exported
`bundle_digest` and current parent snapshot digest as `expected_digest`:

```sh
node scripts/worktree.mjs apply REPO child-a INPUT.json
```

All paths/payloads are checked before writing. Bundle entries must match reviewed
child artifacts; target files must match their before images. Stale bases and
conflicting user changes stop without overwrite. Apply uses an exclusive
integration lock and records intent before writes. A completed repeat on the
exact resulting tree returns the receipt without reapplying. Partial/uncertain
intent or later tree changes stop for manual inspection, without automatic
rollback or an exactly-once execution claim.

After application, hand the returned changed paths and receipt to the reserved
worker, run its bridge, and complete normal finish/review/verify. The worker's
result must include those integrated paths in its actual cumulative round changes.
Apply cannot approve, finish a lease, run tests, launch a worker, stage, commit or
merge to main. Then record the existing explicit receipt:

```sh
node scripts/project.mjs integrate REPO INTEGRATION_RECEIPT_INPUT.json
```

Input names `task_id`, `integration_task_id`, and `reason`; see
[workflow planning](workflow-plan.md). Current parent acceptance and exact child
files remain required. Repeat for the sibling, then run the shared join.

Integration touches only the explicitly leased project workspace, never an
unselected checkout. Dirty worktrees are preserved. There is no automatic
merge-to-main, worker pool, Beads dependency or semantic-conflict guarantee.
Platform CI and actual paired workloads are required before claiming production
reliability or savings.

## Validation snapshot

Local Node 24 verification: 12 focused tests passed and one supervised lifecycle
test was skipped because host process inventory is unavailable. The lifecycle
test is present for environments where process inventory works. No live coding
agent or performance benchmark was run.

The full-suite comparison produced 553 passes / 153 failures / 9 skips against
the unchanged branch's 542 passes / the identical 153 failing names / 8 skips.
That full comparison preceded the final pre-launch application guard; the final
13-test focused run verified that guard. Separate acceptance-security integration
runs both produced 3 passes and the same 6 failing names. These are environment-
limited results, not green full-suite certification. State documentation, syntax
and whitespace checks passed. New Ubuntu/Windows CI is still required.

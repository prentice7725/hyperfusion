# Bounded read-only work (unreleased)

HF-I05 reuses the consultation/review bridge with one or two active invocation slots per task workspace. The pilot default is two; `read_only.slots:1` serializes the same required reviewer seats. This is not a parallel implementation pool, an OS sandbox, or permission to run tests in a shared tree.

## Approve additional analysis

At task init, optionally include this field in the existing brief:

```json
{
  "limits": {"max_wall_ms": 600000},
  "read_only": {
    "slots": 2,
    "subtasks": [
      {"id":"api-audit","executor":"sonnet","paths":["src/api"],"focus":["Inspect the public interface"]},
      {"id":"client-audit","executor":"sol","paths":["src/client"],"focus":["Inspect compatibility with the API"]},
      {"id":"docs-audit","executor":"antigravity","paths":["docs"],"focus":["Check the documented contract"]}
    ]
  }
}
```

Every path must be within the task's approved scope. Executors must also be enabled by the approved team and vendor policy; inherited base review settings cannot enable excluded project members for these subtasks. At most four additional subtask definitions are accepted. A wall-time limit is required when defining subtasks. A project task can contain the same `read_only` field; this opts it into the bounded static workflow even without dependencies, and project approval freezes it with the graph, acceptance and limits. Existing workflows without this optional field retain their frozen definition digest.

Select approved IDs through the existing `consult` action:

```json
{"mode":"committee","question":"Inspect the approved concerns without changing files","subtasks":["api-audit","client-audit","docs-audit"]}
```

Run the returned bridge command, then use `consult-finish` as before. Do not combine a subtask selection with executor or focus overrides. Each selected ID can be reserved once per task, across rounds and restarts. Reservation immediately consumes the existing consultation member-run allowance, including failures and queued invocations that never launch. That allowance remains four per task; required review retains its separate existing caps. There is no new project-wide scheduler or budget reset. Static project task IDs, frozen limits and serial implementation claims continue to bound the project.

## Evidence and coverage

Each reader receives an explicit scope/focus manifest bound to its member, task digest and optional frozen workflow digest. Planned analysis gets its approved paths; mandatory reviewers always get the complete task scope and the existing cumulative changed-file, AC, controller acceptance and rejection context. Adapter-specific diff truncation still requires inspecting the remaining changed files. A focus hint never reduces required panel coverage, changes Grok's medium implementation/designated xhigh review distinction, or grants approval authority.

The controller binds dispatched prompts and manifests to hashes. The bridge refuses modified evidence/focus packets. Before each queued launch it rechecks controller identity, writer and acceptance markers, tree digest and existing observed cost/wall-time budgets. A workspace execution lock prevents overlapping bridge runs and premature settlement while the bridge is alive. Read-only manifests authorize no edits, tests, builds, installs or worktree creation; existing CLI restrictions and post-consult snapshot validation remain in place.

A confirmed failed invocation retains successful siblings' result, usage and process records and may release a slot for queued work. Unknown shutdown, interruption, changed state/tree or budget exhaustion stops the queue. New consultations require process shutdown proof; an unproven launched member prevents settlement and retains the open consultation, blocking subsequent writers. Confirm processes stopped and use the existing recovery/archive protocol rather than replaying a launch marker. Missing mandatory seats remain missing and cannot be replaced by an analysis result or another reviewer's PASS.

## Workspaces and limits

An active same-tree writer or unconfirmed acceptance run prevents reader launches. Reading an independent worktree requires explicitly initializing and calling the controller for that workspace. It is not inferred from disjoint filenames, and this release does not automatically schedule cross-workspace work. Shared Git-control changes can still invalidate a worktree's snapshot. Create planned worktrees before active writer rounds under the existing workflow rules.

Tests use fake CLIs and deterministic scheduler checks for slot limits, shared coverage, failure preservation, shutdown uncertainty, tampering, scope, budget exhaustion and explicit worktree reads. They do not establish live-model latency or cost savings. The HF-I06 parallel-writer gate still requires measured independent workloads and useful HF-I05 wall-time gains; this implementation does not satisfy that gate by itself.

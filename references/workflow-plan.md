# Static project dependencies (unreleased)

HF-I04 extends existing milestone tasks. A task with `depends_on`, `workspace`, `integrates`, or the HF-I05 `read_only` plan opts the project into a static workflow. Plans without these fields retain the existing project behavior. There is no model-generated graph, executable workflow language, automatic merge, or parallel implementation.

## Plan and approve

Each workflow task needs a bounded scope, named ACs with acceptance commands mapped to every AC, and `limits.max_wall_ms` between 1 and 86,400,000. Existing brief validation and optional cost limits apply. Commands already passing on the initial tree still need the existing explicit green-baseline acknowledgement; dependency planning does not waive acceptance checks.

Example task, within the existing `milestones[].tasks` array:

```json
{
  "id": "api",
  "title": "Implement the API",
  "kind": "code",
  "difficulty": "low",
  "depends_on": ["schema"],
  "scope": {"paths": ["src/api", "tests/api"]},
  "success_criteria": ["AC1: API handles the new schema"],
  "acceptance_commands": ["npm test -- api"],
  "acceptance_map": {"AC1": ["npm test -- api"]},
  "limits": {"max_wall_ms": 600000}
}
```

`node scripts/project.mjs schedule REPO` validates and prints a deterministic topological dry run before approval, without model calls or writes. Validation rejects duplicate/missing IDs, duplicate/self/cyclic dependencies, dependencies on later milestones, invalid scopes, incomplete acceptance definitions and unbounded wall budgets. Overlapping scopes are permitted because implementations are serialized. Cross-file changes retain the existing cumulative review and required panel.

The team report includes dependencies, scope, acceptance and limits. Existing user approval freezes them in a controller artifact. After approval, `schedule` and project `status` show ready tasks and blocking reasons. Dispatch claims a task under the existing control lock. Only one implementation may be active or reserved, including isolated worktrees. Future milestones remain gated by the existing checkpoint report and user acknowledgement.

Approved workflow plans are static: `amend` rejects changes. Direct edits to dependency fields, scopes, acceptance or budgets cause a frozen-plan mismatch before init/begin rather than changing the running contract. Legacy plans retain their amendment behavior. A blocked parent leaves dependent tasks unready; no descendant is launched, dropped or marked successful automatically.

## Completion and restart

Project status text or a worker result cannot satisfy an edge. The controller persists a workflow CLOSE receipt only from an ended CLOSE state without a writer or open consultation. Same-workspace dependencies use that receipt after reload. If interruption occurred after task CLOSE but before project settlement, `project.mjs sync REPO INPUT.json` with `{"task_id":"schema"}` explicitly reconciles the terminal task metadata. It does not rerun tests, launch a worker, approve work or invent a CLOSE. Unconfirmed acceptance shutdown remains blocked.

## Isolated tasks and integration

Set `workspace:"isolated"` on an isolated task. Create its workspace with `node scripts/worktree.mjs create REPO TASK_ID`; this reserves the task under the project lock and binds the child to the frozen parent plan. Init and run it in the returned workspace. It uses the approved team, frozen task contract and existing acceptance/review controller. Its CLOSE becomes `awaiting_integration` in the parent project and does not satisfy ordinary dependencies.

Plan exactly one shared-workspace task in the same milestone with `integrates:"TASK_ID"`. This special edge requires the isolated CLOSE but does not require its integration receipt. Its scope must cover the isolated scope, and its acceptance commands must include the isolated acceptance commands. Do not also put that child in the integration task's `depends_on` list. Perform the merge explicitly within this integration task, then use the existing review and verify flow to reach CLOSE in the parent workspace.

Record the integration with `node scripts/project.mjs integrate REPO INPUT.json`:

```json
{"task_id":"isolated-child","integration_task_id":"integrate-child","reason":"Reviewed and verified the integrated changes"}
```

The controller requires both CLOSE receipts, current parent acceptance with process shutdown proof, unchanged tracked and ignored acceptance inputs, and exact agreement between the child's changed scoped files and their integrated parent versions. The explicit receipt then satisfies ordinary dependencies on the child. A stale parent tree, incomplete merge or unreviewed integration is refused. Repeating the same receipt is idempotent. No worktree is merged or deleted automatically.

This first version accepts exact integrations, not conflict resolutions that intentionally differ from the child's final files. Such a change needs a new reviewed plan rather than a guessed correspondence. Keep the isolated workspace and its evidence until integration is recorded. Incomplete reservations or failed parents stop the graph for lead inspection; this release does not automatically cancel or repair them.

Local fake-CLI tests cover graph validation, shared-workspace CLOSE readiness, frozen inputs, serial reservations, restart metadata and isolated integration. Full platform CI and live model evaluation remain separate checks.

# Explicit settlement after interruption (HF-I02, unreleased)

Automatic resume remains disabled. This command never launches a worker or
reviewer, approves a round, verifies a task, resets attempts, or replaces a
session. It settles a completed transport through the existing `finish` or
`consult-finish` controller handler. `SETTLED` describes that operation, not task
success; inspect its returned phase. Only the existing verification path can
produce CLOSE.

## Grant at initialization

Add this field to a **new** task's init brief:

```json
{
  "reconciliation": {
    "policy": "settle-complete",
    "reason": "Allow explicit settlement of completed evidence after interruption"
  }
}
```

The controller removes it from worker briefs and freezes a revision-1 grant in
state and `reconciliation-grant.json`. It cannot be supplied at begin, enabled by
repository configuration, or added to an old task. Existing tasks can still use
read-only `resume` and the documented manual settlement/recovery commands.

For granted tasks, a bridge run with supervised quiescence enabled writes a
`completion-TAG.json` sidecar after persisting its result. The sidecar binds the
task, round, executor, controller-state digest, source-tree digest and hashes of
transport/result evidence. Even a controller-state edit after completion stops
automatic use of that evidence; use manual inspection/settlement instead.
Implementation receipts also bind the dispatched brief and base snapshot.
Each reviewer has an independent completion sidecar. This is local cooperative
provenance, not a signed provider attestation or an exactly-once execution claim.

## Inspect, then explicitly apply

```sh
node scripts/fusion-state.mjs reconcile REPO
```

The default is read-only: no lock creation, process launches, acceptance commands,
state transitions, or receipts. A complete supported round returns
`READY_FOR_REVALIDATION` and an identity. It does **not** establish current
shutdown. Unsupported or incomplete evidence returns `STOPPED` with reason codes.

Copy the returned identity and action into an input file:

```json
{
  "apply": true,
  "expected": {
    "task_id": "HF-example",
    "round": 1,
    "action": "finish",
    "identity": "<64-character identity from the current preview>"
  }
}
```

For `consult-finish`, also include the returned `consult_id` in `expected`.

```sh
node scripts/fusion-state.mjs reconcile REPO apply.json
```

Application is restricted to the recorded completion host and platform. It
acquires the autopilot and controller locks, checks the original
grant, revalidates the bound files and tree, and obtains fresh process inventory.
It never kills processes. Live supervised identities, unavailable inventory,
missing shutdown proof, drift or partial records stop settlement. The bound files
and tree are checked again after inventory. Ordinary scope checks, acceptance
commands and mandatory review policy remain owned by the existing handlers.
Every required reviewer must have complete evidence; missing siblings are not
relaunched and do not get converted into a synthesized pass.

Before calling a handler, the controller creates a deterministic operation intent
receipt. On successful return it records a compact outcome. Repeating the same
expected operation returns that outcome without running acceptance again,
consuming attempts or appending review records. Different identities are refused.
The returned phase belongs to the recorded operation; it is not a fresh approval
of the current tree. Use `resume` to inspect the current state.

## Uncertainty and rollout limits

- A crash before completion evidence is fully persisted requires manual recovery;
  envelope text is not reparsed to manufacture a missing result or receipt.
- A crash between intent and outcome persistence returns
  `OPERATION_OUTCOME_UNCERTAIN`, even if some state/artifacts look complete. Do not
  delete the intent to retry. Inspect the lease, source and acceptance records.
- A previously started `finish`, pending acceptance marker, altered result,
  changed source tree, stale grant, old schema, or lead takeover is not replayed.
- `VERIFICATION_OUTCOME_UNCERTAIN` means verification evidence exists while the
  durable phase is still VERIFY. Do not rerun verify to overwrite that evidence.
  `TERMINAL_SETTLEMENT_INCOMPLETE` means CLOSE/BLOCKED was saved without the
  controller's `ended_at` settlement marker. Read-only `resume` also reports these
  boundaries and does not recommend initializing another task. These checks do
  not certify every downstream metric/project projection as complete.
- Verification and automatic dispatch are outside this command. An isolated
  child's settlement does not imply source integration or parent acceptance.
- Process checks retain the existing supervised-tree limits: escaped processes
  that were never observed cannot be universally identified. Persisted tracked
  PID/creation identities strengthen restart checks; a timestamp alone is not
  proof of shutdown. No timeout or PID age authorizes stealing a writer lease.

## Crash boundary regression command

```sh
npm run test:recovery
```

This runs the settlement and crash tests serially. The crash suite starts real
controller/bridge subprocesses and exits them immediately after a chosen durable
file write or atomic rename. No production fault hook, fake process inventory or
real provider CLI is used. Fixtures preserve an actual earlier rejection and
task-scoped fake-CLI session, plus pre-existing user changes.

| Interruption boundary | Restart disposition |
| --- | --- |
| Dispatch saved, worker not started | Uncertain dispatch; no launch |
| Worker exit/envelope or normalized result saved without completion sidecar | Incomplete evidence; no replay or fabricated receipt |
| Worker completion sidecar persisted | One explicit finish; repeat returns its receipt |
| Reviewer result saved without completion sidecar | Keep open panel; no seat relaunch |
| Reviewer completion sidecar persisted | One explicit consult-finish; no duplicate review |
| Review settlement record saved before state | Uncertain intent; no repeated settlement |
| Raw implementation result or finish phase persisted | Uncertain intent; retained lease/evidence |
| Verification record saved before CLOSE | Verification outcome uncertain; no verification replay |
| CLOSE saved before ended_at | Incomplete terminal settlement; no new-task recommendation |
| Fresh verify acceptance marker saved before running commands | Preserve marker; explicit acceptance recovery required |

Tests assert preserved task identity, attempts, original grant, rejection history
and source changes, and repeated inspection/settlement without new transport
records. A separate paired-panel case also requires every mandatory completion
sidecar and retains the important-task lead gate after both independent passes.
The default `npm test` also discovers both files in the existing
Ubuntu/Windows, Node 20/24 CI matrix. Local fake-CLI results do not establish
live-model effectiveness, all possible crash windows or complete cross-platform
qualification. The full platform checks and live canary remain release gates.

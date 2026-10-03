# Review and routing

Use fresh evidence after the writer stops. Compare task baseline, round snapshots and actual diff/status. Inspect untracked content separately. Existing dirty edits belong to the user. Review source and targeted test output independently; a self-reported successful command is not proof.

Review JSON has verdict, rationale, blocking_criteria (stable criterion IDs), commands_run (actual independent inspection commands), independent_diff_review:true, and optional complexity flags. PASS requires a complete result, no blockers and unchanged post-snapshot. Final verify needs actual passing acceptance evidence. If source changes during verification, recover/review the new tree.

| Verdict | Next action |
|---|---|
| pass | VERIFY |
| helper | Small bounded Luna investigation/fix; one cooperative writer |
| redo | Same writer and session, within its budget |
| resume | Saved external executor/session, including after Luna assistance |
| decision | Lead resolves architecture/requirements; no automatic provider switch |
| alternative | Different external executor after capability check |
| takeover | Core difficulty requires direct lead implementation, recorded lease |

`escalate` is an alias for alternative-provider consideration. External exhaustion produces ALTERNATIVE_REQUIRED. Current M0 has no second external adapter: explicitly choose takeover or report unavailable; do not claim a switch. Luna exhaustion resumes the external executor if it has budget, otherwise requests takeover. Lead exhaustion becomes BLOCKED. An available helper budget is not a reason to turn Luna into the primary implementation engine.

Use brief/result/feedback and bounded relevant logs. Let the external executor perform detailed implementation/test iterations. Optimize lead usage without suppressing independent review or hiding failures. Review only enough to substantiate acceptance and material risk; avoid mechanically re-reading the complete execution transcript.

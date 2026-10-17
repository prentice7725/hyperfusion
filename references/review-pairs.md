# Cross-vendor review pairs

## Lead handoff

Use `review.strategy:"lead-gated-adaptive"`. Classify the work when initializing the approved brief, rather than asking a worker to select its own reviewers. Use `task_criticality:"standard"` for ordinary bounded work, `"important"` for important/complex work, or `assignment_strategy:"dual_review"` for an explicitly requested pair. Existing Sonnet/Sol implementation grants remain mandatory.

Init freezes `review_policy:"cross-vendor-pairs-v1"` in `assignment.json` for new tasks whose approved configuration enables Grok and permits its vendor. Init and begin expose `review_preview` to the lead. This preview is provisional: the controller raises review coverage after inspecting the actual diff for risk paths or modified acceptance tests. The final per-round plan is frozen in `review-plan-N.json`; neither a worker nor a later repository configuration change can shrink it.

| Actual implementer | Standard, non-risk review | Important/APEX, explicit dual, or risk-raised review |
|---|---|---|
| Grok medium | Sol medium | Sol medium + Sonnet high |
| Antigravity | Sol medium | Sol medium + Grok xhigh |
| Haiku | Sol medium | Sol medium + Grok xhigh |
| Luna | Sonnet high | Sonnet high + Grok xhigh |
| Authorized Sonnet | Sol medium | Sol medium + Grok xhigh |
| Authorized APEX Sol | Direct lead review | Direct lead review; never replaced by a delegated pair |

Do not treat Grok medium implementation plus Grok xhigh review as independent. New paired-policy substitutions must use vendors different from the implementer and from the other seated reviewer. Vendor identity here is the built-in member registry, not authenticated attestation of an arbitrary custom model/provider.

## Role-specific effort and independent execution

Keep Grok's normal implementation, classic review and ordinary advisor/committee consultation at the medium default. Only a Grok seat in a paired-policy dual panel receives xhigh. This includes filling that seat on a later consultation after another reviewer already finished. A Grok substitute in an ordinary single-review panel uses its configured normal effort instead. Sol review remains medium and Sonnet review remains high. The panel's role-specific effort overrides the normal member setting only for that review invocation; it never changes frozen implementation configuration or the next worker round.

Run `delegate-review` → emitted `bridge --consult` command → `consult-finish` after confirming process shutdown. The bridge launches the reviewers in parallel. Each gets the same pre-review tree/digest and bounded evidence, without the sibling's verdict. Selected model/effort, role and client-reported usage are recorded separately. Parallel execution does not eliminate Grok xhigh latency: the panel waits for every mandatory result. Actual live-model latency and judgment quality are not certified by fake-CLI transport tests.

## Verdicts and authority

- Every mandatory reviewer passes on the same digest: report the evidence/history to the lead. APPROVE opens VERIFY, not CLOSE. Only a separately granted eligible `standard-auto` policy can bypass a lead decision.
- Every mandatory reviewer gives an in-scope, evidence-backed REDO: the existing `redo_delegation` may send the same worker back within the task's grants and budgets. Repeated criteria, protected-test changes and other unmet conditions stop for the lead.
- PASS/NG disagreement, different digests, missing results or an unavailable mandatory CLI: never synthesize PASS or silently reduce the panel. Retain the records and require the lead. Substitution requires a recorded reason; replacing an earlier rejection does not erase it or authorize approval by itself.

Reviewers never acquire write authority, launch workers, expand scope, change acceptance commands, commit or push. Keep the existing process shutdown, snapshot, test protection and final acceptance checks.

This release does not expand rejection grants: `redo_delegation` remains limited to STANDARD `external_primary` assignments. Important/APEX tasks and explicit `dual_review` assignments therefore require a lead decision even when both reviewers reject. A standard assignment raised to a pair by its actual diff is still subject to every existing rejection-policy check. Pair selection is not permission to bypass these task-level limits.

## Compatibility

Existing assignments without a review-policy field retain `legacy-v1` rules, including an old in-flight review. New approved configurations without Grok, or with xAI disallowed, also keep legacy review rules; this preserves the Claude+Codex-only preset without adding an unapproved team member. A Grok-enabled team with a missing/broken binary does **not** qualify for this fallback: the mandatory seat fails explicitly. Classic review remains unchanged. No task is reinitialized, no attempt budget is reset, and existing records are not rewritten.

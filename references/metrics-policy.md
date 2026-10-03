# Optimize Codex usage per successful task

Primary metric across the whole evaluation cohort:

`sum(lead tokens + Luna tokens, including failed tasks) / successful tasks`

Also record `sum(lead tokens, including failures) / successful tasks`. External Claude/Grok/Antigravity tokens are separate: minimizing their token count is not the primary objective. A large external read/test loop can be acceptable if it preserves quality and reduces Codex usage. External spend and wall time remain visible guardrails, not unlimited budgets.

Run `metrics.mjs REPO [TASK_USAGE.json]`. Optional input is measured task-total accounting:
```json
{"source":"host task-usage export", "lead_tokens":1234, "luna_tokens":56}
```
These totals must include planning, reviews, redo, failures and lead takeover. Do not insert estimates or model guesses. Missing accounting stays null; zero must be genuinely measured. Claude envelopes retain reported usage and client-side cost estimates separately. Native host accounting is not automatically available to these scripts.

Run `metrics.mjs --aggregate METRIC1.json METRIC2.json ...` for the cohort ratio. Failed/archived tasks contribute to the numerator. No successes or incomplete usage coverage yields null, not zero or infinity. Do not compare a raw input token with a monetary dollar figure; cost and token metrics have distinct units.

Compare against GPT-6.1 Sol high solo with success rate, regressions, human intervention, wall time and external cost guardrails. Eight to twelve tasks are a pilot signal, not statistical proof. Match task snapshots and acceptance tests; include difficult failures. The new milestone order is external M0 Claude, M1 Grok, M2 Antigravity, then capability-based auto-routing and broader evaluation.

Use `lead_tokens_per_success` for the model-neutral metric. `astra_tokens_per_success` remains a deprecated compatibility alias with the same value, not evidence that Astra ran. Record requested profile separately from verified host identity.

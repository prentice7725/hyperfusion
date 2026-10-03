# Result contract

Return an object with task_id, round, status, summary, files_read, files_changed, commands_run, tests, unresolved, risks, needs_lead_decision, recommended_next_action. Paths are repository-relative; files_changed describes this round, not every dirty path. Arrays may be empty when nothing was read, changed or run. Never invent tests.

Statuses: complete, blocked, needs_decision, failed. Tests contain command and status (pass, fail, not_run). A complete result cannot contain failed tests, unresolved items or a lead-decision flag. needs_decision requires needs_lead_decision=true. Include the exact command and relevant failure in unresolved/summary; requests for architectural changes stop execution.

Lead passes `{token, quiescent:true, result: OBJECT}` to finish only after the sidekick turn and all its child commands end. Result task_id and round must match active state. The controller compares declared changed paths to actual per-round content changes and checks scope, HEAD and index. It does not prove a test passed: independent verification is mandatory. Invalid result artifacts are preserved and the lease remains held for recovery.

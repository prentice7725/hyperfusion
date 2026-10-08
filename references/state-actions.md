# State action policy

Generated from `scripts/state-policy.mjs`. Do not edit the table manually.

| Phase | Allowed actions |
|---|---|
| PLAN | begin, consult, consult-finish, recover, status, report, archive |
| REDO | begin, consult, consult-finish, recover, status, report, archive |
| ALTERNATIVE_REQUIRED | begin, consult, consult-finish, recover, status, report, archive |
| TAKEOVER_REQUIRED | begin, recover, status, report, archive |
| EXECUTING | finish, recover, status, report, archive |
| REVIEW | review, consult, delegate-review, consult-finish, recover, status, report, archive |
| DECISION_REQUIRED | decide, consult, consult-finish, status, report, archive |
| VERIFY | verify, status, report, archive |
| RECOVERY_REQUIRED | recover, status, report, archive |
| CLOSE | init, status, report, archive |
| BLOCKED | init, status, report, archive |
| ARCHIVED | init, status, report, archive |

`consult` with mode `review` and `delegate-review` require REVIEW. `consult-finish` also requires an open consult. `init` accepts an empty repository state or a terminal phase. `archive` requires quiescence and any held writer token. Status and report never mutate task phase.

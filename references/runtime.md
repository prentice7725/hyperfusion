# State and execution commands

Use `node SKILL/scripts/fusion-state.mjs ACTION REPO_ROOT [INPUT.json]`. Input is a file, never interpolated shell JSON. Only init accepts `--executor NAME`; `--sidekick claude` is a legacy alias. JSON may supply executor on init. Subsequent briefs omit it except for an explicitly reviewed alternative.

| Action / state | Input / result |
|---|---|
| init | Brief and optional executor; PLAN plus baseline and frozen config |
| begin from PLAN | Configured external executor, lease and dispatch |
| begin from REDO | Current writer/session within remaining budget |
| begin from HELPER_REQUIRED | Luna only; bounded helper brief |
| begin from EXTERNAL_REQUIRED | Resume saved external session |
| begin from ALTERNATIVE_REQUIRED | Fresh brief with different supported executor; unavailable providers fail without mutation |
| begin from TAKEOVER_REQUIRED | Brief plus takeover_reason; lead receives a writer lease |
| bind | token, session_id; native helper identity; cannot replace saved ID |
| finish | token, quiescent:true, result; REVIEW or RECOVERY_REQUIRED |
| review | verdict/rationale/evidence; routes next state |
| decide | decision:string; rebrief within budget |
| takeover | reason:string; explicit handoff from alternative, external, decision or redo state |
| verify | acceptance_satisfied:true, actual passing tests/checks; CLOSE |
| recover | token if held, quiescent:true, reason; snapshot and bounded recovery |
| archive | quiescent:true, reason, token if held; preserves task and source, marks ARCHIVED, permits a new task |
| status | Read state/digest; legacy tasks remain inspectable |

Claude begin probes capability before consuming a lease/attempt. Bridge execution uses the returned command/args, once per round. RESULT_READY leaves the lease held. The lead finishes after checking quiescence. Luna begin returns a native collaboration descriptor; bind the returned session ID and use followup on redo. A takeover descriptor authorizes only the leased bounded lead implementation; it does not bypass review and verification.

One external executor may perform many internal reads and tests inside a round; cap is two rounds per executor, two helper rounds per task and one takeover. Current maximum is five mutation rounds. Global iteration identifies artifacts; per-role attempts enforce caps. Interruptions after lease acquisition consume an attempt. Do not reset a counter by archive/re-init to evade the loop cap for the same unfinished task.

Post-snapshot is taken before lease release. control.lock serializes metadata independently of the writer. Artifacts are create-once; state uses atomic replacement. Interruptions never trigger automatic rollback or lock stealing. A missing configured adapter leaves the state unchanged.

Schema v3 expresses external v0.2 roles. Older task states are not silently migrated: inspect, confirm all processes stopped, archive with evidence, then create a genuinely new task or explicitly bounded manual handoff. `lead: sol` selects the requested lead profile. `lead_target_model` and `lead_target_reasoning_effort` record GPT-6.1 Sol/high; `lead_model:null` and `lead_reasoning_effort:null` mean actual host selection is unverified. Historical `astra` takeover ownership/counter keys remain wire-compatible aliases for the lead role; they do not select Astra inference.

Run `node --test SKILL/tests/*.test.mjs`. The fake Claude CLI in tests exercises process/protocol behavior, not live model quality or account authentication.

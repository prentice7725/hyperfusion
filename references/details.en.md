# HyperFusion details

English | [한국어](details.md) | [日本語](details.ja.md)

The [README](../README.md) gives the short version. This page covers the full feature set, configuration, security model, and test limits.

## Features

### Assignment and teams

- **Team → approval → milestones → checkpoints.** A project plan assigns responsibilities before implementation starts. `project.mjs draft` populates installed members and rejects unavailable ones. Milestones pause at checkpoints for user acknowledgment. `project.mjs schedule` manages task dependencies as a frozen plan while implementation stays serial. → [project](project.md) (Korean) · [workflow plans](workflow-plan.md)
- **Capability-based routing.** Capabilities such as `code`, `ui`, `docs`, and `image-gen` determine eligibility. Local rejection history sets the order, and unverified workers receive occasional exploration rounds. Configure models and capabilities for existing adapters under `executors`; adding a new provider requires an adapter implementation. → [routing](routing.md) (Korean)
- **Setup checks and contract smoke tests.** `setup-doctor.mjs` recommends a preset for the installed CLIs without changing your configuration. `--smoke` runs a small real task per installed worker in a temporary repository to check CLI flags, output format, and the result contract after CLI updates. Installation checks do not verify authentication or quota. → [operations](operations.md#doctor-계약-스모크) (Korean)
- **External-First routing.** All A-tier and B-tier workers are automatic implementation candidates routed by tier. Only Sol requires a grant (`APEX`); automatic fallback and exploration never select Sol. A rejected B-tier round escalates to an A-tier worker. Adaptive review (`lead-gated-adaptive`) selects `routing.policy: "external-first"` by default, and classic routing uses the same tier table.

### Evidence and review

- **Verify worker claims.** The controller checks reported files and test results against snapshot diffs and its own re-run of the acceptance commands. False or invalid claims trigger recovery.
- **Concrete rejections.** Rejections require reasons and acceptance IDs (`AC1`, `AC2` …); retries require file- and line-level instructions. Two rejections for the same AC trigger reassignment. Each ordinary worker gets three rounds; lead takeover is limited to one round after all available workers are exhausted.
- **Static-check gate.** The controller runs the brief's `static_commands` (linters and type checkers) at finish and `VERIFY`. Unlike acceptance commands, they must pass on the untouched baseline. A failure goes back to the same worker without review. If a config file listed in `static_protect` changes, the controller skips running the checks and escalates to the lead so a worker cannot disable rules. A task cannot close until static checks pass (`STATIC_NOT_PASSING`). → [static-gate](static-gate.md) (Korean)
- **Red-first acceptance.** Acceptance commands must fail on the untouched baseline. For refactors where tests should already pass, use preserve verification (`verification: {kind: "preserve", protect: [...]}`) so the controller proves via snapshots that protected tests and fixtures stayed untouched.
- **AC trace and PR draft.** `acceptance_map` links AC IDs to acceptance commands. At close, `verification.json`, `report`, and `pr-draft.md` summarize net changes since the first worker baseline (`base-1`). Files not attributable to validated worker rounds are listed separately as `unattributed_changes`. Commits and pushes remain user-directed.
- **Independent delegated review.** Reviewers receive the cumulative net diff (up to 100,000 characters) and controller-run acceptance results, without the worker's summary, test claims, or earlier reviewers' conclusions. An implementer cannot review its own round. A rejection without a file/line finding is not applied as-is. → [review](review-protocol.md) (Korean)
- **Finding ledger and lead dispositions.** Review findings are collected with their raw evidence (`findings`), and the lead records a disposition and reason for each finding. `@findings` forwards only accepted items to the next round, and dispositions feed per-reviewer metrics. Grouping findings never strips raw evidence or mandatory review. → [findings](finding-ledger.md)
- **Advice and committees.** One advisor can inspect a diff, or a two-member committee can investigate repeated failures. Before-and-after snapshots enforce the read-only contract, with at most two slots active at once. → [consult](consult.md) (Korean) · [read-only work](read-only-work.md)
- **Inter-round drift checks.** Each subsequent `begin` compares the working tree against the previous `post_digest`, including writes to scoped files through Bash. Any mismatch stops at `RECOVERY_REQUIRED` before acquiring a lease or consuming an attempt. Retained writes enter cumulative review but cannot count as worker output or qualify for policy approval. User edits present before the first `begin` are preserved. → [recovery](recovery-protocol.md) (Korean)

### Reducing lead load

- **Compact output and `next`.** CLI output defaults to a compact view (`--full` prints all fields). `next` outputs the exact command for the current phase with known tokens and digests filled in.
- **Diagnose and resume.** Read-only `diagnose` reports why a task stopped using stable reason codes, and `resume` gives the next step for an interrupted task. `reconcile` runs only when explicitly permitted at `init`. → [reconciliation](reconciliation.md)
- **Task-level delegation (opt-in).** When the lead grants `delegation` at `init`, the controller can approve eligible `STANDARD` rounds as `delegated-policy`, retry transient worker failures that changed no files, and substitute unavailable reviewers from another vendor. If any condition fails, execution stops at the lead gate. → [supervisor](universal-supervisor.md#위임-승인-재량권) (Korean)
- **Autopilot.** Round execution and independent delegated review run automatically within recorded gates and budgets. `report.lead_load` separates direct lead decisions, policy decisions, lead packets, and recovery counts.
- **Resume after compaction.** A `SessionStart` hook injects the active task and next command once when a session starts or after context compaction.
- **Status line.** `fusion-state.mjs line`, the `UserPromptSubmit` hook, and `mods/hf-status` display the same phase, worker round, and next-action line. → [operations](operations.md#작업-상태-표시) (Korean)
- **Rule candidates.** `memory.mjs rule-candidates` lists `error` memories repeated across two or more tasks as read-only candidates for machine checks. Memories promoted into a rule file leave recall and return if that rule file changes or disappears. → [static-gate](static-gate.md) (Korean)
- **Local memory.** Approved lessons from errors, procedures, and episodes are stored locally without an external server and shared across sessions and workers. Writes and recalls require lead approval and are filtered by source and version; secret-shaped strings are rejected. → [memory](memory.md) (Korean) · [memory recall](memory-recall.md)
- **Notifications.** `HF_NOTIFY_URL` (such as an ntfy endpoint) sends status-only push notifications when a worker finishes or a lead decision is needed.

### Control and audit

- **Single writer.** Only one worker edits at a time, leaving round snapshots and artifacts. Interruptions enter recovery, and nothing is committed, pushed, or deployed automatically.
- **Lead guard hooks.** `PreToolUse` blocks lead `Edit`, `Write`, and non-read-only MCP tools while a worker holds the lease or worker budget remains; `Stop` blocks ending a turn while lead action is due. Bash writes are caught instead by snapshots and inter-round drift checks. → [operations](operations.md#리드-가드-훅) (Korean)
- **Worktree isolation and budgets.** Independent tasks run in separate worktrees with isolated state, writer leases, reported cost limits, and elapsed time limits. Results are reviewed separately before integration. → [operations](operations.md) (Korean)
- **Universal local monitoring.** Implementation, review, and consultation share one supervisor (`status --monitor`, `monitor --once|--watch`). Silence emits a `QUIET` warning rather than fabricated progress or success, and monitoring makes no model calls.
- **Cross-platform support.** Linux, macOS, and Windows are supported; CI runs on Ubuntu and Windows.

## Adaptive review (opt-in)

Setting the review strategy to `lead-gated-adaptive` applies the review rules below and the final lead gate, and sets automatic assignment to External-First. Both `hyperfusion.v03.config.example.json` and the presets `setup-doctor` recommends when Claude and Codex are installed (`claude-codex`, `external-first`) use this strategy. Existing classic configurations and tasks in progress are not changed automatically. → [universal-supervisor](universal-supervisor.md) (Korean)

- **Owner-aware review.** Standard tasks use one independent reviewer. Important tasks, explicit dual-review tasks, and risk-path changes use the cross-vendor pairs below in parallel. An implementer never reviews its own round. Reviewer substitution requires a recorded reason, and an earlier rejection is never erased by another `PASS`. Conflicting or missing reviews stay at the lead gate. Existing assignments and approved Grok-free teams keep their prior rules.
- **Final lead gate.** Results pause at `LEAD_DECISION_REQUIRED`. Neither `auto_apply`, review adoption, nor autopilot can skip it; only an explicit task-level `delegation` grant authorizes policy approval, and unattributed changes block that approval.

| Implementer | Important / dual / risk-path pair |
|---|---|
| Grok | Sol `xhigh` + Sonnet `max` |
| Luna / Terra | Sonnet `max` + Grok `xhigh` |
| AGY / Haiku / Sonnet | Sol `xhigh` + Grok `xhigh` |
| Authorized APEX Sol | Direct lead review (no delegated pair) |

The lead sets criticality and strategy in the approved brief at `init` and checks `review_preview`. Only unanimous evidence-backed `NG` verdicts can trigger an init-granted `redo_delegation`; disagreements go to the lead. Even a unanimous `PASS` goes to the lead unless a separate eligible approval grant exists. Host model identity is not authenticated, recorded as `authority.model_verified: false`. → [review-pairs](review-pairs.md)

## Vendors and models

- **AGY model family and effort.** Configuring `executors.antigravity.model: "gemini-4-argon"` and `reasoning_effort: "high"` separately resolves to `gemini-4-argon-high`. A suffixed model pins its effort, and a conflicting `reasoning_effort` fails before launch. Resolved slugs are checked against `agy models`, and unavailable variants are never silently substituted. → [configuration](configuration.md#agy-모델-계열과-effort-분리-argon) (Korean)
- **Codex.** JSONL thread and turn usage is recorded, and a task-scoped implementation thread is resumed by exact ID only after verifying compatible `exec resume` flags. Reviews always start in a fresh, read-only session. Operator-only build cache/network options and Claude/Grok turn ceilings are documented in [Codex runtime](codex-runtime.md).
- **Vendor limits.** `allowed_vendors: ["anthropic", "openai"]` restricts implementation, review, and consultation together. The operator environment variable `HF_ALLOWED_VENDORS` acts as an upper bound that repository config cannot widen, and the bridge re-checks it before launch. This is not a firewall, DLP, or vendor attestation. New CLIs still require audited adapters (`scripts/member-registry.mjs`).
- **Default reasoning effort.** Implementation defaults are Terra `medium`, Grok `high`, Sonnet `medium`, Luna `xhigh`, Haiku `max`, and Antigravity Gemini 4 Hydrogen `high`. Review seats use Sol `xhigh`, Sonnet `max`, and Grok `xhigh`, independent of implementation effort. Setting `reasoning_effort: null` omits the normal flag without clearing a mandatory review role's effort.

## Measurement

- **Lead usage.** Generated hooks collect actual per-model usage from the local Claude Code transcript on `Stop`, `SessionEnd`, and `StopFailure`. Missing evidence stays unknown, and explicit `TASK_USAGE.json` observations take precedence. These figures reflect client-reported usage, not a billing API. → [metrics policy](metrics-policy.md) (Korean)
- **Benchmarks.** `benchmark.mjs cases` lists fixed pilot cases, and `compare BASELINE.json HYPERFUSION.json` compares paired metrics. Failed tasks remain in cost numerators, and missing pairs or unmeasured usage block savings claims. `--suite large` selects cases built from real feature commits; repeated large-suite results are in the [README](../README.md#measured-results). → [benchmark-pilot](benchmark-pilot.md)
- **Usage and quota.** Accounting covers failed calls, reviews, consultations, and APEX implementation; unmeasured values stay `null`. `quota-policy.mjs record` accepts operator-recorded quota, while `collect-codex` reads local Codex `rate_limits` without making network or model calls. Expired or unsourced records are treated as unknown.

## Security

These controls are **cooperative rules, not an OS sandbox**.

- Control state, briefs, and snapshots live outside the workspace in `~/.hyperfusion/state/` (overridable via `HF_STATE_DIR`). Workers cannot widen their own scope.
- Snapshots watch Git config and hooks, linked worktree `config.worktree`, `.env`, self-ignored `.gitignore`, `node_modules/.bin`, and the `agy` workspace folders (`.agents/`, `.agent/`, `_agents/`, `_agent/`). Before each controller Git call, HyperFusion re-reads effective Git configuration (including conditional includes and worktree settings) and neutralizes runnable drivers. Unreadable config halts with `GIT_CONFIG_UNREADABLE`.
- The bridge reconstructs and validates dispatch requests right before launch and passes only the environment variables each worker needs.
- Bash rules allow narrow test, lint, and build command shapes. Relaxations such as disabling an implementation sandbox require operator environment variables. → [configuration](configuration.md#보안-관련-환경변수) (Korean)
- Read-only reviews and consultations are enforced through before-and-after snapshots rather than CLI sandboxes (any violation discards the response). `agy --sandbox` restricts only its terminal, not its file-write tools.

Workers with shell access can write outside the repository, and snapshots cannot detect writes outside the repository root. Ordinary ignored dependency files (such as `node_modules/dep/index.js`) are not snapshot-hashed; instead, the controller compares ignored-file metadata before running acceptance commands and blocks execution if anything changed unless explicitly handled. → [operations](operations.md#수용-테스트-자동-실행) (Korean)

For legacy in-workspace control storage, run `fusion-state.mjs migrate <repository>`; incompatible schemas follow the archive procedure in [configuration](configuration.md) (Korean) and [recovery](recovery-protocol.md) (Korean).

## Installation and usage

Requirements: Node.js 24+, Git supporting `git config --show-scope --includes`, a **Git repository with an initial commit** (a remote is optional), and at least one installed and authenticated CLI among `claude`, `grok`, `agy`, and `codex`.

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

Select Opus 5.5 in Claude Code and run:

```text
/hyperfusion <task description>
/hyperfusion --executor sonnet <task description>
```

The lead follows [SKILL.md](../SKILL.md) to invoke the controller and bridge. From the skill directory, run `node scripts/setup-doctor.mjs <repository>` first to inspect installed CLIs. Repository settings live in `<repository>/hyperfusion.config.json` (see `hyperfusion.config.example.json`).

### Lead guard hooks

Run `npm run guard:settings` in the skill directory and merge the printed `hooks` block into `~/.claude/settings.json` (or `<repository>/.claude/settings.json`). The generated config uses absolute paths on this machine and covers `PreToolUse`, `Stop`, `SessionStart`, `UserPromptSubmit`, `PreModelSwitch`, `PostModelSwitch`, `SessionEnd`, and `StopFailure`. Blocking guard commands set `onFailure: "block"` (Claude Code v2.1.295+), so a crashed or timed-out guard blocks the tool call. When upgrading, merge the new usage-collection commands, the MCP tool guard (`mcp__.*`), and the model-switch entries while keeping unrelated hooks intact and avoiding duplicate commands.

### Autopilot

Run `node scripts/fusion-state.mjs autopilot <repository>` on an initialized task; `next` recommends it for the first round at any difficulty when these conditions hold:

- Acceptance commands have a recorded `red` baseline (or a recorded `green` baseline for `preserve` verification).
- Classic review also requires `review.auto_apply: true` (`lead-gated-adaptive` stops at the lead gate regardless of that setting).

Control returns to the lead at `VERIFY`, design decisions, recovery, `BLOCKED`, and takeover. Tasks with an explicit `delegation` grant can proceed through policy approval and verification to `CLOSE`. → [operations](operations.md#오토파일럿) (Korean)

### Shutdown proofs and outgoing masking

Acceptance execution also requires child-process shutdown proof; missing proof stops at `RECOVERY_REQUIRED` until the lead confirms shutdown, and task time limits apply to acceptance and final verification as well.

By default, HyperFusion masks email, IP, key, and password patterns—along with Korean and Japanese personal identifiers (resident and foreigner registration numbers, My Number, phone, card, bank account, passport, driver license, residence card, and pension numbers)—in outgoing briefs, diffs, and prior results while preserving vendor authentication variables. This is not DLP for repository files read directly by a CLI; enforce your own file-access and external-transfer policies. → [transmission scope](operations.md#외부-전송-마스킹) (Korean)

## Tests and limitations

```sh
npm test
```

Automated tests cover state transitions, worker adapters, routing, delegated review, delegation and automatic recovery, local memory, project workflows, security, redaction, and autopilot. Live CLI smoke tests require `HF_LIVE=1`. CI runs on Ubuntu and Windows with Node 24. Because Windows runs test files serially (a full run on one machine takes several hours), CI splits Windows across four runners (`HF_TEST_SHARD`, while other platforms use concurrency 2), and tests that spawn real orphan processes run separately after the main suite.

**The `grok`, `agy`, `claude`, and `codex` executables in the test suite are mock CLIs.** These tests do not validate live model quality, authentication, or image generation. If an installed CLI lacks required flags, execution fails before launch with `ADAPTER_UNAVAILABLE`. Adapter flags follow the [Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md), [Antigravity CLI](https://antigravity.google/docs/cli/headless), and [Claude Code](https://code.claude.com/docs/en/headless) headless docs. Transient-error classification is based on mock-CLI coverage, so inspect early live `recovery-*.json` `reason` fields. Real-model lead-token measurements are in the [README](../README.md#measured-results).

## License

MIT. See [LICENSE](../LICENSE).

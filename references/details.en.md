# HyperFusion details

English | [한국어](details.md) | [日本語](details.ja.md)

The [README](../README.md) gives the short version. This page keeps the full feature list, settings, security notes and test notes.

## Features

**Assignment and teams**

- **Team → approval → milestones → checkpoints.** A project plan records responsibilities before implementation. `project.mjs draft` pre-fills installed members and rejects unavailable ones. Milestones stop at checkpoints for acknowledgment. `project.mjs schedule` manages task dependencies as a frozen plan; implementation stays serial. See [project](project.md) and [workflow plans](workflow-plan.md).
- **Capability-based routing.** Capabilities such as `code`, `ui`, `docs`, and `image-gen` determine eligibility. Local rejection history affects order; new workers get occasional exploration attempts. Configure existing adapters' models and capabilities in `executors`; a new provider requires an adapter implementation. See [routing](routing.md).
- **Setup checks and contract smoke.** `setup-doctor.mjs` recommends a preset for the installed CLIs without changing configuration. `--smoke` runs a small actual task per installed worker in a temporary repository to check flags, output, and the result contract after CLI updates. Installation checks do not verify authentication or quota. See [operations](operations.md#doctor-계약-스모크).
- **External-First implementation.** All A-tier and B-tier workers are automatic implementation candidates, routed by tier. Only Sol needs a grant (APEX). Automatic fallback and exploration cannot select Sol. A rejected B-tier round goes to an A-tier worker. Adaptive review (`lead-gated-adaptive`) selects this routing by default (`routing.policy:"external-first"`); classic routing uses the same tier table.

**Evidence and review**

- **Check worker claims.** Reported files and outcomes are checked against snapshot diffs and controller-run acceptance commands. Invalid claims require recovery.
- **Concrete rejections.** Rejections need reasons and acceptance IDs; retries need file/line instructions. Two rejections for the same AC trigger reassignment. Ordinary workers have three rounds each; lead takeover is limited to one after available workers are exhausted.
- **Red-first acceptance.** Acceptance commands must fail on the untouched baseline. Refactors that should already pass can use preserve verification, `verification:{kind:"preserve",protect:[...]}`, to prove protected tests/fixtures remain unchanged.
- **AC trace and PR draft.** `acceptance_map` connects AC IDs to acceptance commands. `verification.json`, `report`, and `pr-draft.md` use the final net changes since the first worker baseline (`base-1`). Files not attributable to validated worker rounds appear separately as `unattributed_changes`. Commit and push remain user-directed.
- **Independent delegated review.** Reviewers receive every net task change (diff up to 100,000 characters) and controller acceptance results, but not the worker's summary/test claims or earlier reviewers' conclusions. The implementer cannot review its own round. A rejection without a file/line finding is not applied as-is. See [review](review-protocol.md).
- **Finding ledger and lead dispositions.** Review findings are collected with their raw evidence (`findings`), and the lead records a disposition and reason per finding. `@findings` forwards only accepted findings, and the dispositions become per-reviewer metrics. Grouping never removes raw evidence or mandatory review. See [findings](finding-ledger.md).
- **Advice and committees.** One advisor can inspect a diff, or two committee members can investigate repeated failures. Before/after snapshots enforce the read-only contract; at most two slots run at once. See [consult](consult.md) and [read-only work](read-only-work.md).
- **Inter-round drift checks.** A subsequent `begin` compares the tree with the previous `post_digest`, including writes to scoped files through Bash. A mismatch stops at `RECOVERY_REQUIRED` before acquiring a lease or consuming an attempt. Retained writes enter cumulative review but cannot count as worker contributions or receive policy approval. User edits present before the first `begin` are preserved. See [recovery](recovery-protocol.md).

**Less work for the lead**

- **Compact output and `next`.** CLI output defaults to a compact view; `--full` exposes all fields. `next` supplies the current command and known tokens/digests.
- **Diagnose and resume.** Read-only `diagnose` reports why a task stopped with stable reason codes, and `resume` gives the next step for an interrupted task. `reconcile` runs only when granted at init. See [reconciliation](reconciliation.md).
- **Optional discretion.** A task-level `delegation` grant at init lets the controller approve an eligible STANDARD round as `delegated-policy`, retry certain transient failures, and substitute unavailable reviewers from another company. Every condition must pass; otherwise the lead gate remains. See [supervisor](universal-supervisor.md#위임-승인-재량권).
- **Autopilot.** Round execution and independent delegated review can run automatically within the recorded gates and budgets. `report.lead_load` distinguishes lead decisions, policy decisions, lead packets, and recovery counts.
- **Resume after compaction.** A SessionStart hook injects the active task and next action once after a new session or compaction.
- **Status line.** `fusion-state.mjs line`, the UserPromptSubmit hook, and `mods/hf-status` expose the same phase/worker/next-action line. See [operations](operations.md#작업-상태-표시).
- **Local memory.** Approved lessons from errors, procedures, and episodes can be reused across sessions and workers without an external server. Writes and recalls require lead approval and are filtered by source and version; secret-shaped content is rejected. See [memory](memory.md) and [memory recall](memory-recall.md).
- **Notifications.** `HF_NOTIFY_URL`, for example an ntfy endpoint, sends status-only completion and decision notifications.

**Control and audit**

- **Single writer.** One worker writes at a time, with round snapshots and artifacts. Interruptions enter recovery. There is no automatic commit, push, or deployment.
- **Lead guard hooks.** PreToolUse blocks lead Edit/Write and non-read-only MCP tools while a worker owns the lease or worker budget remains; Stop reminds the lead about pending work. Bash writes are checked by snapshots and inter-round drift detection instead. See [operations](operations.md#리드-가드-훅).
- **Worktree isolation and budgets.** Independent tasks can run in separate worktrees with isolated state and leases, reported cost limits, and time limits. Reviewed results are integrated separately. See [operations](operations.md).
- **Local universal monitoring.** Implementation, review, and consultation share supervision (`status --monitor`, `monitor --once|--watch`). Silence is a QUIET warning, not progress or success. Monitoring makes no model calls.
- **Linux, macOS, and Windows support.** CI currently covers Ubuntu and Windows.

## Adaptive review (opt-in)

Setting the review strategy to `lead-gated-adaptive` applies the review rules below and the final lead gate, and switches automatic assignment to External-First. The presets `setup-doctor` recommends when Claude and Codex are installed (`claude-codex`, `external-first`) and `hyperfusion.v03.config.example.json` use this strategy. Existing classic configurations and tasks in progress are not changed automatically. See [universal-supervisor](universal-supervisor.md).

- **Owner-aware review.** Standard tasks keep one independent reviewer. Important/explicit-dual/risk-raised tasks use the pairs below, independently in parallel. Substitution needs a recorded reason; a supported rejection is not erased by another PASS. Conflicts and missing results stay at the lead gate. Existing assignments and approved Grok-free teams retain their previous rules.
- **Final lead gate.** Results stop at `LEAD_DECISION_REQUIRED`; `auto_apply`, review adoption, and autopilot cannot skip it. Only an explicit task-level discretion grant can authorize policy approval, and unattributed changes block that approval.

| Implementer | Important / dual / risk-raised pair |
|---|---|
| Grok | Sol xhigh + Sonnet max |
| Luna / Terra | Sonnet max + Grok xhigh |
| AGY / Haiku / Sonnet | Sol xhigh + Grok xhigh |
| Authorized APEX Sol | Direct lead review, not a delegated pair |

The lead sets criticality/strategy in the approved brief at init and checks `review_preview`. Unanimous evidence-backed NG can use an init-granted `redo_delegation`; disagreement cannot. A unanimous PASS goes to the lead unless a separate eligible approval policy was granted. Host model identity is not authenticated: `authority.model_verified:false` records this limitation. See [review-pairs](review-pairs.md).

## Vendors and models

- **AGY model family and effort.** Configure `executors.antigravity.model:"gemini-4-argon"` and `reasoning_effort:"high"` separately to select `gemini-4-argon-high`. A suffixed model keeps its effort; conflicting effort fails before launch. Resolved slugs are checked against `agy models`, and unavailable variants are not substituted. See [configuration](configuration.md#agy-모델-계열과-effort-분리-argon).
- **Codex.** JSONL thread/turn usage is recorded, and a task-scoped implementation thread is resumed by exact ID only when compatible `exec resume` flags are confirmed. Reviews are always fresh and read-only. Operator-only build cache/network options and Claude/Grok turn ceilings are in [Codex runtime](codex-runtime.md).
- **Vendor limits.** `allowed_vendors:["anthropic","openai"]` narrows implementation, review and consultation together; operator `HF_ALLOWED_VENDORS` is an upper bound repository configuration cannot widen. The bridge checks again before spawning. This is not a firewall/DLP or vendor attestation. New CLIs need audited adapters (`scripts/member-registry.mjs`).
- **Default reasoning effort.** Implementation: Terra medium, Grok high, Sonnet medium, Luna xhigh, Haiku max, Antigravity Gemini 3.8 Flash high. Review seats: Sol xhigh, Sonnet max, Grok xhigh, separate from implementation effort. Override `reasoning_effort`; `null` omits the normal flag, not a mandatory role's effort.

## Measurement

- **Lead usage.** Generated hooks collect actual per-model usage from the local Claude Code transcript on Stop/SessionEnd/StopFailure. Missing evidence stays unknown; explicit `TASK_USAGE.json` observations take precedence. This is client-reported usage, not a billing API. See [metrics policy](metrics-policy.md).
- **Benchmarks.** `benchmark.mjs cases` lists fixed pilot cases; `compare BASELINE.json HYPERFUSION.json` compares actual paired metrics. Failed tasks stay in cost numerators, and missing pairs or unknown usage suppress savings claims. `--suite large` selects cases built from real feature commits. Large-suite results from two repeated runs are in the [README](../README.md#measured-results). See [repeated benchmark](benchmark-pilot.md).
- **Usage and quota.** Include failed calls, reviews, consultations, and APEX implementation; unknown values remain `null`. `quota-policy.mjs record` accepts operator records; `collect-codex` reads local Codex `rate_limits` without a network/model call. Expired records become unknown.

## Security

These are **cooperative controls, not an OS sandbox**.

- Control state, briefs, and snapshots live outside the workspace at `~/.hyperfusion/state/` (`HF_STATE_DIR` overrides it).
- Snapshots watch Git settings/hooks, linked worktree `config.worktree`, `.env`, self-ignored `.gitignore`, `node_modules/.bin`, and the agy workspace folders (`.agents/`, `.agent/`, `_agents/`, `_agent/`). Before each controller Git call, effective configuration including conditional includes and worktree settings is re-read and runnable drivers are neutralized. Unreadable configuration stops with `GIT_CONFIG_UNREADABLE`.
- The bridge reconstructs and validates dispatch requests before launch and passes only required worker environment variables.
- Bash rules accept narrow test/lint/build command shapes. Relaxations such as disabling an implementation sandbox require operator environment variables. See [configuration](configuration.md#보안-관련-환경변수).
- Read-only reviews and consultations are checked through before/after snapshots. AGY's `--sandbox` restricts its terminal, not its file-write tools.

Workers with shell access can write outside the repository; snapshots cannot detect those writes. Ordinary ignored dependency contents, such as `node_modules/dep/index.js`, are not snapshot-hashed. Before controller acceptance execution, ignored-file metadata is compared and changes block execution unless explicitly handled. See [operations](operations.md#수용-테스트-자동-실행). For legacy in-workspace control storage, run `fusion-state.mjs migrate <repository>`; other incompatible schemas require the documented archive procedure. See [configuration](configuration.md) and [recovery](recovery-protocol.md).

## Installation and usage

Requirements: Node.js 24+, Git with `git config --show-scope --includes`, a **Git repository with an initial commit** (a remote is optional), and at least one installed/authenticated worker CLI among `claude`, `grok`, `agy`, and `codex`.

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

Select Opus 5.5 in Claude Code, then invoke:

```text
/hyperfusion <task description>
/hyperfusion --executor sonnet <task description>
```

The lead follows [SKILL.md](../SKILL.md). From the installed skill directory, run `node scripts/setup-doctor.mjs <repository>` to check worker CLI support. Configuration belongs to the target repository's `hyperfusion.config.json`; see `hyperfusion.config.example.json`.

**Lead guard hooks.** Run `npm run guard:settings` in the skill directory and merge the printed `hooks` into `~/.claude/settings.json` or the target repository's `.claude/settings.json`. The output uses absolute paths and includes PreToolUse, Stop, SessionStart, UserPromptSubmit, PreModelSwitch, PostModelSwitch, SessionEnd and StopFailure. Blocking guard commands carry `onFailure: "block"` (Claude Code v2.1.295+), so a crashed or timed-out guard blocks the tool call. Existing installs must merge the new usage commands, the MCP tool guard (`mcp__.*`) entry and the model-switch entries as well; preserve unrelated hooks and avoid duplicating existing commands.

**Autopilot.** Run `node scripts/fusion-state.mjs autopilot <repository>` for an initialized task; `next` suggests it for the first round at any difficulty when these conditions hold. Acceptance commands must have a recorded red baseline, or a recorded green baseline for preserve verification. Classic review also requires `review.auto_apply:true`; adaptive review stops at the lead gate regardless of that setting. VERIFY, design decisions, recovery, BLOCKED, and takeover return control to the lead. Explicit discretion can continue eligible policy-approved work through verification to CLOSE. See [operations](operations.md#오토파일럿).

Acceptance execution also requires child-process shutdown proof. Missing proof stops at RECOVERY_REQUIRED. Time limits cover acceptance and final verification too.

Outgoing brief/diff/prior-result text masks email, IP, key, and password patterns by default. Vendor authentication variables are retained. This is not DLP for repository files that a CLI reads directly; apply your own file-access and external-transfer policies. See [transmission scope](operations.md#외부-전송-마스킹).

## Tests and limitations

```sh
npm test
```

Automated tests cover state transitions, adapters, routing, reviews, discretion/recovery, memory, project workflows, security, redaction, and autopilot. Live CLI tests require `HF_LIVE=1`. CI is configured for Ubuntu/Windows × Node 24. Windows runs test files serially (a full run on one Windows machine takes hours), so CI splits the Windows job across four runners (`HF_TEST_SHARD`); other platforms use concurrency 2. Tests creating actual orphan processes run separately after the main suite. `npm run spawns` counts subprocesses by command and calling site.

**The test `grok`/`agy`/`claude`/`codex` executables are fake CLIs.** These tests do not validate live model quality, authentication, or image generation. Missing required CLI flags cause `ADAPTER_UNAVAILABLE` before execution. Adapter flags follow the cited [Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md), [Antigravity CLI](https://antigravity.google/docs/cli/headless), and [Claude Code](https://code.claude.com/docs/en/headless) documentation. Transient-error classification is based on fake-CLI coverage; inspect early live `recovery-*.json` reasons. Real-model lead-token results are in the [README](../README.md#measured-results).

Licensed under [MIT](../LICENSE).

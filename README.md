# HyperFusion

v0.27.0 adds read-only diagnostics and resume packets, explicitly granted recovery reconciliation, a review-finding ledger, static task dependencies, bounded read-only work, provenance-aware memory and repeated A/B benchmarks. The lead spends fewer turns on controller plumbing (flag inputs, a bridge-printed finish command, autopilot for proven low tasks), and Windows supervision is faster. See [reconciliation](references/reconciliation.md), [workflow plans](references/workflow-plan.md), [memory](references/memory.md), and [CHANGELOG](CHANGELOG.md).

Evidence retrieval experiment (unreleased): read-only `evidence REPO` pushes controller-detected risk signals with raw artifact hashes, and `evidence-search REPO QUERY.json` runs a bounded, redacted keyword search over controller evidence. Neither participates in approval. See [experiment design and limits](references/evidence-retrieval-experiment.md).

Optional [controller overhead tools](references/controller-overhead.md) measure local inspection time and statically check task briefs without launching models or acceptance commands.

English | [한국어](README.ko.md) | [日本語](README.ja.md)

**Claude Opus 5.5 plans and reviews; other models implement the work.** HyperFusion is a Claude Code skill that delegates implementation and test iteration to Sonnet, Haiku, Grok, Antigravity, or Luna, with independent reviews available through Sol.

> **Versions.** The package release is `0.27.0` (`package.json`). **v0.3** names the optional External-First + universal supervision profile. Storage schema 4, architecture `opus-lead-v0.3`, and wire protocol `hyperfusion-opus-lead-v0.5` are separate compatibility identifiers defined in `scripts/versions.mjs`. See [CHANGELOG](CHANGELOG.md).

## Unreleased controller improvements

| Area | Entry point and limits |
| --- | --- |
| Stops and metrics (HF-I01) | Read-only `diagnose`, stable reason codes and observed timing/usage; unknown values remain unknown. |
| Interrupted tasks (HF-I02) | Read-only `resume` and init-granted explicit `reconcile`; no worker relaunch or automatic approval. |
| Review findings (HF-I03) | `findings`, `revision-packet` and `@findings`; grouping never removes raw evidence or mandatory review. |
| Static dependencies (HF-I04) | `project.mjs schedule`, frozen plans, CLOSE/integration receipts and checkpoint acknowledgment. Implementation stays serial. |
| Read-only work (HF-I05) | At most two consultation/review slots with frozen scopes and complete mandatory coverage. |
| Memory (HF-I07) | Source/version filters, bounded recall, candidate batch review and separate retrieval/usefulness observations. |

Usage: [reconciliation](references/reconciliation.md), [findings](references/finding-ledger.md), [workflow plans](references/workflow-plan.md), [read-only work](references/read-only-work.md), [memory recall](references/memory-recall.md), [repeated benchmark](references/benchmark-pilot.md).

New execution authority requires explicit grants; diagnostics and metrics do not grant it. Parallel implementation (HF-I06) is excluded from this core change and remains a separate draft experiment. Real-model cost/time savings are unmeasured; platform results must be checked on the exact PR head. Detailed history is in [CHANGELOG](CHANGELOG.md).

## Why HyperFusion

1. **Reduce lead-model token use.** Opus owns planning, rejection, and final review. Workers handle implementation and test loops. The project records lead tokens per successful task; unmeasured usage stays unknown.
2. **One point of contact.** The user works with the lead, which assigns workers, checks their claims, sends concrete revision orders, and changes workers after repeated failures.

## AGY model family and effort (0.23.0)

Configure `executors.antigravity.model:"gemini-4-argon"` and `reasoning_effort:"high"` separately. The adapter selects `gemini-4-argon-high` without a duplicate effort flag. A pinned `-medium` suffix retains medium; conflicting explicit effort fails before launch. Optional `models_by_difficulty` selects implementation families; reviews use the base model. Resolved slugs are checked against `agy models`, and unavailable variants are not substituted. Without a model no effort is sent or recorded (agy reads effort from the model id); an operator `reasoning_effort` with no model fails with `EFFORT_NEEDS_MODEL`. Defaults and account settings are unchanged. `usage_by_model_effort` separates dispatch-selected family/effort with unknown fields kept null. See [configuration](references/configuration.md#agy-모델-계열과-effort-분리-argon). Live AGY inference/access has not been tested here.

## Codex and egress improvements (0.22.0)

Codex workers now collect JSONL thread/turn usage and resume an exact task-scoped implementation thread when compatible `exec resume` flags are confirmed; unsupported versions stay stateless. Reviews remain fresh and read-only. Cached input is a subset of input, not an extra token charge. [Codex runtime](references/codex-runtime.md) covers operator-only build cache/network options and configurable Claude/Grok turn ceilings (default 40).

Set `allowed_vendors:["anthropic","openai"]` to narrow implementation, review and consultation together. Operator `HF_ALLOWED_VENDORS=anthropic,openai` is an upper bound that repository configuration cannot widen. The bridge checks again before spawning; this cooperative dispatch policy is not a firewall/DLP or vendor attestation for arbitrary model overrides. Built-in metadata is centralized in `scripts/member-registry.mjs`; new CLIs still require audited adapters. Classic low-code routing now starts with Luna. A short English [executor map](references/executor-quickstart.md) reduces reference loading; generic CLI/ACP and full state-machine extraction remain unimplemented.

For future local commits, use your verified GitHub noreply address with repository-local `git config user.email`. Existing public author metadata is not removed without an explicit history-rewrite request.

## Usage measurement and installed teams (0.21.0)

The generated hooks now bind the host session and collect assistant usage from the local Claude Code transcript on Stop/SessionEnd/StopFailure. Input, output, cache read and cache creation tokens are counted by actual model, with streamed message duplicates and resumed sessions handled once. The first terminal Stop includes the closing summary; later prompts do not extend that task. Missing evidence stays unknown. Explicit `TASK_USAGE.json` observations take precedence. This is client-reported usage, not a billing API. See [metrics policy](references/metrics-policy.md).

`node scripts/project.mjs draft REPO` (or `roster REPO --draft`) proposes an installed team and pre-fills missing members in `excluded`. Proposal and approval reject unavailable team members. `setup-doctor.mjs` recommends a preset without changing configuration or approving it. When only Claude and Codex are installed, the proposed `claude-codex` preset uses Luna for low difficulty and Sonnet for medium/high non-image tasks, with Sol/Sonnet cross review. User approval of the project authorizes these controller-issued Sonnet grants; explicit assignments remain authoritative. Installation checks do not verify authentication or quota.

`node scripts/benchmark.mjs cases` lists ten fixed pilot cases. `node scripts/benchmark.mjs compare BASELINE.json HYPERFUSION.json` compares arrays of actual paired metrics with `case_id`, explicit `success`, host usage and total Claude tokens. Failed tasks remain in cost numerators. Missing pairs, unknown usage or incompatible measurement scopes suppress savings claims. The tool makes no model calls. The pilot has not been run with live models, so no token savings are claimed.


## Team

| Member | Configured model / CLI | Default role |
|---|---|---|
| **Opus (lead)** | claude-opus-5-5 | Team selection, planning, rejection, final review; no implementation while workers remain available |
| Sonnet | claude-sonnet-5-5 | Medium/high-complexity code, tests, refactoring |
| Haiku | claude-haiku-5-5 | Small code changes, documentation, test additions through the Claude Code CLI |
| Grok | Grok CLI | Image assets and straightforward implementation |
| Antigravity | agy | UI, frontend, documentation; no image-generation capability |
| Luna | gpt-6-luna (Codex) | Small fixes, mechanical bulk edits, image-asset assistance |
| Sol | gpt-6.1-sol (Codex) | Reviews and committee advice by default; implementation only in a granted v0.3 APEX round |

These assignments are starting points. Routing filters by capabilities and task kind/difficulty, then uses local history, time decay, and exploration. Uninstalled workers are skipped. A temporary preflight failure consumes no attempt; a missing worker executable can trigger reassignment. Model IDs are configuration defaults whose availability must be checked against the installed CLI and account.

## Task flow

```text
Lead: plan (brief + acceptance commands) → init → begin
Worker: implement under a single writer lease → report results
Controller: finish (snapshot diff, acceptance execution, process shutdown proof)
Review: independent read-only inspection
Lead: pass / redo / alternative / decision / takeover → verify → CLOSE
```

Only `CLOSE` means success. Run `node scripts/fusion-state.mjs next <repository>` to get the next command and an input template with controller-known values.

## Features

**Assignment and teams**

- **Team → approval → milestones → checkpoints.** A project plan records responsibilities before implementation. Milestones stop at checkpoints for acknowledgment. See [project](references/project.md).
- **Capability-based routing.** Capabilities such as `code`, `ui`, `docs`, and `image-gen` determine eligibility. Local rejection history affects order; new workers get occasional exploration attempts. Configure existing adapters' models and capabilities in `executors`; a new provider requires an adapter implementation. See [routing](references/routing.md).
- **Contract smoke checks.** `setup-doctor.mjs --smoke` runs a small actual task per installed worker in a temporary repository to check flags, output, and the result contract after CLI updates. See [operations](references/operations.md#doctor-계약-스모크).

**Evidence and review**

- **Check worker claims.** Reported files and outcomes are checked against snapshot diffs and controller-run acceptance commands. Invalid claims require recovery.
- **Concrete rejections.** Rejections need reasons and acceptance IDs; retries need file/line instructions. Two rejections for the same AC trigger reassignment. Ordinary workers have three rounds each; lead takeover is limited to one after available workers are exhausted.
- **Red-first acceptance.** Acceptance commands must fail on the untouched baseline. Refactors that should already pass can use preserve verification, `verification:{kind:"preserve",protect:[...]}`, to prove protected tests/fixtures remain unchanged.
- **AC trace and PR draft.** `acceptance_map` connects AC IDs to acceptance commands. `verification.json`, `report`, and `pr-draft.md` use the final net changes since the first worker baseline (`base-1`). Reverted intermediate edits are omitted. Files not attributable to validated worker rounds appear separately as `unattributed_changes`. Commit and push remain user-directed.
- **Delegated cumulative review.** Reviewers receive every net task change, controller acceptance results, and a diff of up to 100,000 characters; adapters may apply smaller limits. `changed_files` is cumulative, while `round_changed_files` identifies the current round. Truncated or untracked content must be read directly. The implementer cannot review its own round. See [review](references/review-protocol.md).
- **Advice and committees.** One advisor can inspect a diff, or two committee members can investigate repeated failures. Before/after snapshots enforce the read-only contract. See [consult](references/consult.md).
- **Inter-round drift checks.** A subsequent `begin` compares the tree with the previous `post_digest`, including writes to scoped files through Bash. A mismatch stops at `RECOVERY_REQUIRED` before acquiring a lease or consuming an attempt. Preflight writes are checked too. Recovery refreshes the expected digest, but retained writes still enter cumulative review and cannot receive policy approval as worker contributions. User edits present before the first `begin` are preserved. See [recovery](references/recovery-protocol.md).

**Less work for the lead**

- **Compact output and `next`.** CLI output defaults to a compact view; `--full` exposes all fields. `next` supplies the current command and known tokens/digests.
- **Optional discretion.** A task-level `delegation` grant at init lets the controller approve an eligible STANDARD round as `delegated-policy`, retry certain transient failures, and substitute unavailable reviewers from another company. Every condition must pass; otherwise the lead gate remains. See [supervisor](references/universal-supervisor.md#위임-승인-재량권).
- **Autopilot.** Round execution and independent delegated review can run automatically within the recorded gates and budgets. `report.lead_load` distinguishes lead decisions, policy decisions, lead packets, and recovery counts.
- **Resume after compaction.** A SessionStart hook injects the active task and next action once after a new session or compaction.
- **Status line.** `fusion-state.mjs line`, the UserPromptSubmit hook, and `mods/hf-status` expose the same phase/worker/next-action line. See [operations](references/operations.md#작업-상태-표시).
- **Local memory.** Approved lessons from errors, procedures, and episodes can be reused across sessions and workers without an external server. Writes and recalls require lead approval; secret-shaped content is rejected. See [memory](references/memory.md).
- **Notifications.** `HF_NOTIFY_URL`, for example an ntfy endpoint, sends status-only completion and decision notifications.

**Control and audit**

- **Single writer.** One worker writes at a time, with round snapshots and artifacts. Interruptions enter recovery. There is no automatic commit, push, or deployment.
- **Lead guard hooks.** PreToolUse blocks lead Edit/Write while a worker owns the lease or worker budget remains; Stop reminds the lead about pending work. Bash writes are not blocked by the Edit/Write hook and are checked by snapshots and inter-round drift detection. See [operations](references/operations.md#리드-가드-훅).
- **Worktree isolation and budgets.** Independent tasks can run in separate worktrees with isolated state and leases, reported cost limits, and time limits. Reviewed results are integrated separately. See [operations](references/operations.md).
- **Linux, macOS, and Windows support.** CI currently covers Ubuntu and Windows.

## v0.3: External-First and universal supervision (opt-in)

Copy `hyperfusion.v03.config.example.json` to the target repository as `hyperfusion.config.json` to select the profile explicitly. Existing classic tasks are not migrated automatically. See [universal-supervisor](references/universal-supervisor.md).

- **External-First implementation.** Grok, Antigravity, and Luna are automatic implementation candidates. Sonnet needs an important/reassignment grant; Sol needs an APEX grant. Automatic fallback and exploration cannot select either grant-only implementer.
- **Owner-aware review.** Standard tasks keep one independent reviewer. Important/explicit-dual/risk-raised tasks use the pairs below, independently in parallel. Substitution needs a recorded reason; a supported rejection is not erased by another PASS. Conflicts and missing results stay at the lead gate. Existing assignments and approved Grok-free teams retain their previous rules.
- **Final lead gate.** Results stop at `LEAD_DECISION_REQUIRED`; `auto_apply`, review adoption, and autopilot cannot skip it. Only an explicit task-level discretion grant can authorize policy approval, and unattributed changes block that approval.
- **Local universal monitoring.** Implementation, review, and consultation share supervision (`status --monitor`, `monitor --once|--watch`). Silence is a QUIET warning, not progress or success. Monitoring makes no model calls.
- **Usage and quota.** Include failed calls, reviews, consultations, and APEX implementation; unknown values remain `null`. `quota-policy.mjs record` accepts operator records; `collect-codex` reads local Codex `rate_limits` without a network/model call. Expired records become unknown.
- **Default reasoning effort.** Sonnet high, Haiku max, Antigravity high, Grok medium, Luna xhigh, Sol medium. Grok implementation and ordinary consultation stay at medium unless explicitly overridden; a designated adaptive dual-review seat uses xhigh. Override `reasoning_effort`; `null` omits the normal flag, not a mandatory role's effort.

| Implementer | Important / dual / risk-raised pair |
|---|---|
| Grok medium | Sol medium + Sonnet high |
| Luna | Sonnet high + Grok xhigh |
| AGY / Haiku / authorized Sonnet | Sol medium + Grok xhigh |
| Authorized APEX Sol | Direct lead review, not a delegated pair |

The lead sets criticality/strategy in the approved brief at init and checks `review_preview`. Unanimous evidence-backed NG can use an init-granted `redo_delegation`; disagreement cannot. A unanimous PASS goes to the lead unless a separate eligible approval policy was granted. See [review-pairs](references/review-pairs.md).
- Host model identity is not authenticated: `authority.model_verified:false` records this limitation.

## Security

These are **cooperative controls, not an OS sandbox**.

- Control state, briefs, and snapshots live outside the workspace at `~/.hyperfusion/state/` (`HF_STATE_DIR` overrides it).
- Snapshots watch Git settings/hooks, linked worktree `config.worktree`, `.env`, self-ignored `.gitignore`, `node_modules/.bin`, and the agy workspace folders (`.agents/`, `.agent/`, `_agents/`, `_agent/`: hooks and skills agy runs during a round). Before each controller Git call, effective configuration includes conditional includes and worktree settings; runnable drivers are neutralized. Unreadable configuration stops with `GIT_CONFIG_UNREADABLE`. Dotted driver/include names are checked too. Fresh configuration queries add subprocess overhead; HEAD and both Git directories still use one rev-parse call.
- The bridge reconstructs and validates dispatch requests before launch and passes only required worker environment variables.
- Bash rules accept narrow test/lint/build command shapes. Relaxations such as disabling an implementation sandbox require operator environment variables. See [configuration](references/configuration.md#보안-관련-환경변수).
- Read-only reviews and consultations are checked through before/after snapshots. AGY's `--sandbox` restricts its terminal, not its file-write tools.

Workers with shell access can write outside the repository; snapshots cannot detect those writes. Ordinary ignored dependency contents, such as `node_modules/dep/index.js`, are not snapshot-hashed. Before controller acceptance execution, ignored-file metadata is compared and changes block execution unless explicitly handled. See [operations](references/operations.md#수용-테스트-자동-실행). For legacy in-workspace control storage, run `fusion-state.mjs migrate <repository>`; other incompatible schemas require the documented archive procedure. See [configuration](references/configuration.md) and [recovery](references/recovery-protocol.md).

## Installation and usage

Requirements: Node.js 24+, Git with `git config --show-scope --includes`, a **Git repository with an initial commit** (a remote is optional), and at least one installed/authenticated worker CLI among `claude`, `grok`, `agy`, and `codex`. Actual model and flag availability depends on the installed CLI/account.

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

The lead follows [SKILL.md](SKILL.md). From the installed skill directory, run `node scripts/setup-doctor.mjs <repository>` to check worker CLI support. Configuration belongs to the target repository's `hyperfusion.config.json`; see `hyperfusion.config.example.json`.

**Lead guard hooks.** Run `npm run guard:settings` in the skill directory and merge the printed `hooks` into `~/.claude/settings.json` or the target repository's `.claude/settings.json`. The output uses absolute paths and includes PreToolUse, Stop, SessionStart, UserPromptSubmit, SessionEnd and StopFailure. Existing installs must merge the new usage commands and the MCP tool guard (`mcp__.*`) entry as well; preserve unrelated hooks and avoid duplicating existing commands.

**Autopilot.** Run `node scripts/fusion-state.mjs autopilot <repository>` for an initialized task. Acceptance commands must have a recorded red baseline, or a recorded green baseline for preserve verification. Classic review also requires `review.auto_apply:true`; adaptive review stops at the lead gate regardless of that setting. VERIFY, design decisions, recovery, BLOCKED, and takeover return control to the lead. Explicit discretion can continue eligible policy-approved work through verification to CLOSE. See [operations](references/operations.md#오토파일럿).

Acceptance execution also requires child-process shutdown proof. Missing proof stops at RECOVERY_REQUIRED. Time limits cover acceptance and final verification too.

Outgoing brief/diff/prior-result text masks email, IP, key, and password patterns by default. Vendor authentication variables are retained. This is not DLP for repository files that a CLI reads directly; apply your own file-access and external-transfer policies. See [transmission scope](references/operations.md#외부-전송-마스킹).

## Documentation

Reference documents are primarily Korean. Start with [runtime](references/runtime.md) and [configuration](references/configuration.md).

| Topic | References |
|---|---|
| State and commands | [runtime](references/runtime.md), [state-actions](references/state-actions.md), [state-schema](references/state-schema.json), [operations](references/operations.md) |
| Configuration | [configuration](references/configuration.md) |
| Workers and routing | [executor-runtime](references/executor-runtime.md), [routing](references/routing.md) |
| Contracts | [delegation-protocol](references/delegation-protocol.md), [result-protocol](references/result-protocol.md) |
| Review | [review-protocol](references/review-protocol.md), [consult](references/consult.md), [universal-supervisor](references/universal-supervisor.md) |
| Failure and recovery | [failure-protocol](references/failure-protocol.md), [recovery-protocol](references/recovery-protocol.md) |
| Projects, memory, metrics | [project](references/project.md), [memory](references/memory.md), [metrics-policy](references/metrics-policy.md) |
| Design and historical records | [app-handoff-design](references/app-handoff-design.md), [archive](references/archive/README.md) |

## Tests and limitations

```sh
npm test
```

Automated tests cover state transitions, adapters, routing, reviews, discretion/recovery, memory, project workflows, security, redaction, and autopilot. Live CLI tests require `HF_LIVE=1`. CI is configured for Ubuntu/Windows × Node 24. Windows runs test files serially; other platforms use concurrency 2. Tests creating actual orphan processes run separately after the main suite. `npm run spawns` counts subprocesses by command and calling site to measure performance changes.

**The test `grok`/`agy`/`claude`/`codex` executables are fake CLIs.** These tests do not validate live model quality, authentication, or image generation. Missing required CLI flags cause `ADAPTER_UNAVAILABLE` before execution. Adapter flags follow the cited [Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md), [Antigravity CLI](https://antigravity.google/docs/cli/headless), and [Claude Code](https://code.claude.com/docs/en/headless) documentation. Transient-error classification is based on fake-CLI coverage; inspect early live `recovery-*.json` reasons.

Licensed under [MIT](LICENSE).

## References and inspiration

- [Orca](https://github.com/stablyai/orca), [Paseo](https://github.com/getpaseo/paseo): advisors/committees, located feedback, notifications. Their worktree competition model was not adopted.
- [AnchorMind](https://github.com/jinho-von-choi/memento-mcp): memory ideas including duplicate merging, contradiction review, decay, and provenance; implemented locally rather than integrated as a service.
- [cli-dispatch](https://github.com/rbinar/cli-dispatch): AGY model-name checks, post-compaction context, and local Codex quota reading. Its patch/worktree approach was not adopted.

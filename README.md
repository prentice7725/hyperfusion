# HyperFusion

English | [한국어](README.ko.md) | [日本語](README.ja.md)

![Opus plans at the drafting table; worker models write code; another model reviews in the glass booth](assets/hero.png)

**Opus plans and reviews. Other models write the code.**

HyperFusion is a Claude Code skill. Claude Opus 5.5 acts as the team lead, while other models—Terra, Grok, Sonnet, Luna, Haiku, and Antigravity—implement and test changes as workers. Reviews come from a model built by a different vendor that did not write the code.

## Why

When Opus writes code, runs tests, and reads long logs, it burns expensive tokens fast. A cheaper model, or a model on another subscription, can handle that work.

HyperFusion splits the responsibilities:

- **Opus** decides what to build, reviews the result, and passes or rejects it.
- **Workers** write the code and run the tests.
- **You** talk only to Opus, and Opus manages the workers.

> Goal: **spend fewer Opus tokens at the same quality, accepting that tasks take longer.**

## How it works

```text
  You
    │  "build this feature"
    ▼
  Lead (Opus) ── writes the brief and pass criteria (acceptance tests)
    │
    ▼
  Worker (Terra, Grok, Sonnet …) ── writes code and runs tests
    │
    ▼
  Controller ── diffs the changed files and runs the acceptance tests itself
    │           (never takes a worker's "done" on trust)
    ▼
  Reviewer (another vendor's model that did not write the code) ── read-only review
    │
    ▼
  Lead (Opus) ── pass → done / reject → back to a worker with concrete fix orders
```

- **Acceptance tests must fail first.** Before any work starts, the controller runs them on the untouched code and confirms that they fail. A test that already passes proves nothing.
- **Rejections require a reason.** "Try again" is not accepted. The lead names which criterion (`AC1`, `AC2` …) failed and why.
- **A worker that repeats a mistake is replaced.**
- **Only one worker edits files at a time.** Each round leaves a snapshot.
- **Autopilot.** Worker runs and reviews proceed on their own; the lead steps in only to decide.

## Measured results

We ran five large tasks (`L01`–`L05`) under the same conditions and compared the lead's (Opus) token usage. The tasks come from real feature commits in this repository, and quality was scored against hidden tests that neither the workers nor the lead ever saw.

| Task | HyperFusion lead tokens (run 1 / run 2) | Opus alone (run 1 / run 2) |
|---|---|---|
| L01 | 221K / 477K | 434K / 414K |
| L02 | 240K / 272K | 642K / 429K |
| L03 | 623K / 736K | 1.04M / 719K |
| L04 | 293K / 131K | 256K / 206K |
| L05 | 149K / 307K | 307K / 411K |
| **Total** | **1.53M / 1.92M (mean 1.73M)** | **2.68M / 2.18M (mean 2.43M)** |

- **Opus tokens:** about **29% fewer** on average, though results vary widely by task. On the smallest task (`L04`), Opus alone sometimes used fewer tokens.
- **Quality:** HyperFusion passed 48 of 50 hidden tests (25/25 in run 1, 23/25 in run 2), compared with 24 of 25 for Opus alone (run 2).
- **Time:** much longer. A single task took 17–108 minutes with HyperFusion versus 3–7 minutes with Opus alone (run 2).

### Method and limits

- Token figures are input-equivalent: cache writes count 1.25×, cache reads 0.1×, and output 5×.
- Worker tokens and costs are excluded from the table; workers are assumed to run on another subscription or a cheaper model.
- Each setup ran twice. The skill also changed between runs: run 2 added [#112](https://github.com/prentice7725/hyperfusion/pull/112), which keeps worker test runs focused, and [#114](https://github.com/prentice7725/hyperfusion/pull/114), which gives workers and reviewers a boundary checklist.
- Measured on 2026-11-10 and 2026-11-11 on a single Windows 11 machine.
- Full methodology is in the [benchmark document](references/benchmark-pilot.md).

### Workers alone

We also gave each worker the same five tasks with no lead and no reviewer—one round each, 15 runs per worker (2026-11-14). Runs passing all hidden tests: Terra 15, Sonnet 15, Grok 13, Gemini 4 Hydrogen 12, and Gemini 3.8 Flash 7. None edited files outside its scope. Because Hydrogen scored below Grok (13), the lowest A-tier worker, Antigravity now defaults to Hydrogen and stays in B-tier ([tiers](#team)). → [worker capability trial](references/archive/worker-capability-trial.md) (Korean)

## Team

| Member | Model | Work |
|---|---|---|
| **Opus (lead)** | `claude-opus-5-5` | Planning, decisions, final review. Writes no code while workers still have budget |
| Terra | `gpt-6.1-terra` (Codex) | Medium and hard code, tests, refactoring |
| Grok | Grok 4.7 CLI | Implementation, image assets, reviews |
| Sonnet | `claude-sonnet-5-5` | Implementation, reviews |
| Luna | `gpt-6-luna` (Codex) | Small fixes, repetitive bulk edits |
| Haiku | `claude-haiku-5-5` | Easy code, documentation, extra tests |
| Antigravity | `agy` (Gemini 4 Hydrogen high) | UI, frontend, documentation. Not for personal Google plans (see [Safety](#safety)) |
| Sol | `gpt-6.1-sol` (Codex) | Mostly reviews and advice |

### Tiers and routing

- **Tiers.** A-tier consists of Terra, Grok, and Sonnet; B-tier consists of Luna, Haiku, and Antigravity. Easy code, UI, and documentation start with B-tier, and a rejected B-tier round escalates to A-tier.
- **Fable lead.** On plans that offer Fable (such as Max), Fable can lead. Opus then becomes a review and advice worker and takes over rounds that A-tier workers fail. → [Fable lead](references/configuration.md#fable-리드와-opus-일꾼) (Korean)
- **Adaptive routing.** Only installed workers are used, and a single worker is enough. These roles are a starting point; the lead adjusts assignments from each worker's rejection history. → [Routing](references/routing.md) (Korean)

## Install and use

### Requirements

- Node.js 24 or later
- A Git repository with an initial commit (no remote needed)
- At least one of `claude`, `grok`, `agy`, or `codex`, installed and signed in (do not use `agy` on a personal Google plan; see [Safety](#safety))

### Install

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

### Run

Select Opus 5.5 in Claude Code and run:

```text
/hyperfusion <task>
/hyperfusion --executor sonnet <task>
```

At any stage, `node scripts/fusion-state.mjs next <repository>` prints the next command to run.

### Configuration and hooks

- **Check the setup:** `node scripts/setup-doctor.mjs <repository>` inspects your installed CLIs and recommends a configuration.
- **Team file:** add `--write-team` to draft `~/.hyperfusion/team.json` from your installed CLIs. Edit that file to pick the active workers, models, and reasoning efforts on this machine. → [Team file](references/configuration.md#이-컴퓨터의-팀-파일-hyperfusionteamjson) (Korean)
- **Repository configuration:** `hyperfusion.config.json` in the target repository. See `hyperfusion.config.example.json`.
- **Lead guard hooks (recommended):** merge the `hooks` output from `npm run guard:settings` into `~/.claude/settings.json`. They prevent the lead from editing files with Edit and Write tools while a worker holds the lease or worker budget remains. They do not block Bash writes; the snapshot check between rounds catches those. → [Details](references/details.en.md#installation-and-usage)

## Safety

### Masking and state

- Before sending text to a worker, HyperFusion masks email, IP, key, and password patterns, plus Korean and Japanese personal identifiers (resident and My Number IDs, phone, card, bank account, passport, driver license, residence card, and pension numbers).
- Task state lives outside the repository in `~/.hyperfusion/state/`.
- Nothing is committed, pushed, or deployed automatically.

### Boundaries

**These are collaboration rules, not an OS sandbox.** A worker with shell access can reach files outside the repository. For company code, enforce your own file-access and data-transfer policies. → [Security details](references/details.en.md#security)

### Antigravity on personal Google plans

**Do not run Antigravity as a worker on a personal Google plan.** On 2026-11-09, a Google staff member [confirmed](https://discuss.ai.google.dev/t/terms-section-6-may-a-local-script-run-the-official-agy-cli-when-launched-by-another-vendors-ai-tool/199021) that a third-party agent such as Claude Code invoking `agy -p` on a personal plan (Free, Pro, Ultra) violates section 6 of the Antigravity terms and can trigger automatic account suspension. HyperFusion does exactly that when it hands a round to Antigravity, and call pacing does not change it.

Disable the worker in your team file (`"antigravity": {"enabled": false}`), or use a Google API key, Vertex AI, or Gemini Enterprise instead; HyperFusion has not verified whether `agy` runs on an API key. If a suspension notice appears anyway, HyperFusion stops launching that CLI on this machine until you clear it with `setup-doctor --clear-suspension agy`. → [Team file](references/configuration.md#자리-제한과-호출-간격) (Korean)

## More to read

- [Details](references/details.en.md): all features, adaptive review, vendor settings, measurement, security, and tests
- [CHANGELOG](CHANGELOG.md) (Korean): changes by version. The current package version is `0.35.0`.
- New here? Start with [runtime](references/runtime.md) (Korean; commands) and [configuration](references/configuration.md) (Korean; settings). The English quick reference for the lead is [executor-quickstart](references/executor-quickstart.md).

In the topic table below, links marked `(ko)` point to Korean documentation; all other links are in English.

| Topic | Documents |
|---|---|
| State and commands | [runtime](references/runtime.md) `(ko)` · [state-actions](references/state-actions.md) · [operations](references/operations.md) `(ko)` |
| Configuration | [configuration](references/configuration.md) `(ko)` · [codex-runtime](references/codex-runtime.md) |
| Workers | [executor-runtime](references/executor-runtime.md) `(ko)` · [routing](references/routing.md) `(ko)` · [herdr](references/herdr.md) `(ko)` |
| Briefs and results | [delegation-protocol](references/delegation-protocol.md) `(ko)` · [result-protocol](references/result-protocol.md) `(ko)` |
| Review | [review-protocol](references/review-protocol.md) `(ko)` · [review-pairs](references/review-pairs.md) · [finding-ledger](references/finding-ledger.md) · [consult](references/consult.md) `(ko)` · [universal-supervisor](references/universal-supervisor.md) `(ko)` |
| Failure and recovery | [failure-protocol](references/failure-protocol.md) `(ko)` · [recovery-protocol](references/recovery-protocol.md) `(ko)` · [reconciliation](references/reconciliation.md) |
| Projects, memory, metrics | [project](references/project.md) `(ko)` · [memory](references/memory.md) `(ko)` · [metrics-policy](references/metrics-policy.md) `(ko)` · [benchmark-pilot](references/benchmark-pilot.md) |

## Tests and limits

```sh
npm test
```

- CI runs on Ubuntu and Windows with Node 24.
- The `grok`, `agy`, `claude`, and `codex` binaries used in the test suite are mock CLIs. These tests do not check live model quality, authentication, or image generation.
- The only real-model measurements are the [measured results](#measured-results) above.

## License

MIT. See [LICENSE](LICENSE).

## Inspired by

- [Orca](https://github.com/stablyai/orca), [Paseo](https://github.com/getpaseo/paseo): advisor and committee consults, line-level feedback, notifications
- [AnchorMind](https://github.com/jinho-von-choi/memento-mcp): memory-layer design (duplicate merging, contradiction review, decay, provenance)
- [cli-dispatch](https://github.com/rbinar/cli-dispatch): `agy` model-name checks, state injection after compaction, reading Codex quota
- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills): withholding worker claims from reviewers, finding categories
- [cursor/plugins pstack](https://github.com/cursor/plugins/tree/main/pstack): per-finding dispositions (`Act on` / `Consider` / `Noted` / `Dismissed`)
- [mattpocock/skills](https://github.com/mattpocock/skills): reviews split into standards and spec, task breakdown by dependency graph

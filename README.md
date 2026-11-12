# HyperFusion

English | [한국어](README.ko.md) | [日本語](README.ja.md)

**Opus plans and reviews. Other models write the code.**

HyperFusion is a Claude Code skill. The expensive model, Claude Opus 5.5, acts as the team lead. Other models do the implementation and testing as workers: Terra, Grok, Sonnet, Luna, Haiku and Antigravity. Reviews come from a model of another company that did not write the code.

## Why

When Opus writes code, runs tests and reads long logs, it burns expensive tokens fast. A cheaper model, or a model on another subscription, can do that work.

So the work is split:

- **Opus** decides what to build, looks at the result, and passes or rejects it.
- **Workers** write the code and run the tests.
- **You** talk to Opus only. Opus manages the workers.

> Goal: **spend fewer Opus tokens with the same quality, accepting that tasks take longer.**

## How it works

```text
  You
    │  "build this feature"
    ▼
  Lead (Opus) ── writes the brief and the pass criteria (acceptance tests)
    │
    ▼
  Worker (Terra, Grok, Sonnet …) ── writes code and runs tests
    │
    ▼
  Controller ── compares the changed files and runs the acceptance tests itself
    │           (a worker's "done" is never taken on trust)
    ▼
  Reviewer (another model that did not write the code) ── read-only review
    │
    ▼
  Lead (Opus) ── pass → done / reject → back to a worker with concrete fix orders
```

- **Acceptance tests must fail first.** Before work starts, the controller runs them on the untouched code and checks that they fail. A test that already passes would prove nothing.
- **A rejection needs a reason.** "Try again" is not accepted. The lead names which criterion (AC1, AC2 …) is unmet and why.
- **A worker that repeats a mistake is replaced.**
- **Only one worker edits files at a time.** Each round leaves a snapshot.
- **Autopilot.** Worker runs and reviews proceed on their own. The lead wakes up only to decide.

## Measured results

We ran five large tasks (L01–L05) under the same conditions and compared the lead's (Opus) tokens. The tasks come from real feature commits in this repository. Quality was scored with hidden tests that neither the workers nor the lead saw.

| Task | HyperFusion lead tokens (run 1 / run 2) | Opus alone (run 1 / run 2) |
|---|---|---|
| L01 | 221K / 477K | 434K / 414K |
| L02 | 240K / 272K | 642K / 429K |
| L03 | 623K / 736K | 1.04M / 719K |
| L04 | 293K / 131K | 256K / 206K |
| L05 | 149K / 307K | 307K / 411K |
| **Total** | **1.53M / 1.92M (mean 1.73M)** | **2.68M / 2.18M (mean 2.43M)** |

- **Opus tokens:** about **29% fewer** on average. Results vary a lot by task. On the small task (L04), Opus alone sometimes used fewer.
- **Quality:** hidden tests passed 48/50 for HyperFusion (25/25 in run 1, 23/25 in run 2) and 24/25 for Opus alone (run 2).
- **Time:** much longer. One task took 17–108 minutes with HyperFusion and 3–7 minutes with Opus alone (run 2).

**How to read this, and its limits**
- Token figures are input-equivalent. Cache writes count 1.25×, cache reads 0.1× and output 5×.
- Worker tokens and costs are not in the table. Workers are assumed to run on another subscription or a cheaper model.
- Each side ran twice only. The skill also changed between runs (run 2 included #112 and #114).
- Measured on 2026-11-10 and 11-11 on one Windows 11 machine.
- See the [benchmark document](references/benchmark-pilot.md) for the method.

## Team

| Member | Model | Work |
|---|---|---|
| **Opus (lead)** | claude-opus-5-5 | Planning, decisions, final review. Writes no code while workers remain |
| Terra | gpt-6.1-terra (Codex) | Medium and hard code, tests, refactoring |
| Grok | Grok 4.7 CLI | Implementation, image assets, reviews |
| Sonnet | claude-sonnet-5-5 | Implementation, reviews |
| Luna | gpt-6-luna (Codex) | Small fixes, repetitive bulk edits |
| Haiku | claude-haiku-5-5 | Easy code, documentation, extra tests |
| Antigravity | agy (Gemini 3.8 Flash high) | UI, frontend, documentation |
| Sol | gpt-6.1-sol (Codex) | Mostly reviews and advice |

On a plan that offers Fable (such as Max), Fable can lead. Opus then becomes a review and advice worker and takes over rounds that A-tier workers failed. → [Fable lead](references/configuration.md#fable-리드와-opus-일꾼) (Korean)

Only installed workers are used, and one is enough. These roles are a starting point: the lead changes them based on each worker's rejection history. → [Routing](references/routing.md)

## Install and use

You need:
- Node.js 24 or later
- a Git repository with an initial commit (no remote needed)
- at least one of `claude`, `grok`, `agy` or `codex`, installed and signed in

```sh
# Linux / macOS
git clone https://github.com/prentice7725/hyperfusion.git ~/.claude/skills/hyperfusion
```

```powershell
# Windows (PowerShell)
git clone https://github.com/prentice7725/hyperfusion.git "$env:USERPROFILE\.claude\skills\hyperfusion"
```

Pick Opus 5.5 in Claude Code and run:

```text
/hyperfusion <task>
/hyperfusion --executor sonnet <task>
```

- **Check the setup:** `node scripts/setup-doctor.mjs <repository>` looks at the installed CLIs and recommends a configuration.
- **Team file:** add `--write-team` to draft `~/.hyperfusion/team.json` from the installed CLIs. Edit that file to choose the workers, models and efforts on this machine. → [Team file](references/configuration.md#이-컴퓨터의-팀-파일-hyperfusionteamjson) (Korean)
- **Configuration:** `hyperfusion.config.json` in the target repository. See `hyperfusion.config.example.json`.
- **Lead guard hooks (recommended):** merge the `hooks` printed by `npm run guard:settings` into `~/.claude/settings.json`. They stop the lead from editing files while a worker is on the job. → [Details](references/details.en.md#installation-and-usage)
- **What next:** at any stage, `node scripts/fusion-state.mjs next <repository>` prints the next command.

## Safety

- Text sent to workers has email, key and password patterns masked.
- Task state lives outside the repository in `~/.hyperfusion/state/`.
- Nothing is committed, pushed or deployed automatically.

**These are collaboration rules, not an OS sandbox.** A worker with a shell can reach files outside the repository. For company code, set your own file-access and data-transfer policy. → [Security details](references/details.en.md#security)

## More to read

- [Details](references/details.en.md): all features, adaptive review, vendor settings, measurement, security, tests
- [CHANGELOG](CHANGELOG.md) (Korean): changes by version. The current package version is `0.32.0`.
- New here? Start with [runtime](references/runtime.md) (commands) and [configuration](references/configuration.md) (settings). The English lead summary is [executor-quickstart](references/executor-quickstart.md).

| Topic | Documents |
|---|---|
| State and commands | [runtime](references/runtime.md) · [state-actions](references/state-actions.md) · [operations](references/operations.md) |
| Configuration | [configuration](references/configuration.md) · [codex-runtime](references/codex-runtime.md) |
| Workers | [executor-runtime](references/executor-runtime.md) · [routing](references/routing.md) · [herdr](references/herdr.md) |
| Briefs and results | [delegation-protocol](references/delegation-protocol.md) · [result-protocol](references/result-protocol.md) |
| Review | [review-protocol](references/review-protocol.md) · [review-pairs](references/review-pairs.md) · [finding-ledger](references/finding-ledger.md) · [consult](references/consult.md) · [universal-supervisor](references/universal-supervisor.md) |
| Failure and recovery | [failure-protocol](references/failure-protocol.md) · [recovery-protocol](references/recovery-protocol.md) · [reconciliation](references/reconciliation.md) |
| Projects, memory, metrics | [project](references/project.md) · [memory](references/memory.md) · [metrics-policy](references/metrics-policy.md) · [benchmark-pilot](references/benchmark-pilot.md) |

## Tests and limits

```sh
npm test
```

- CI runs on Ubuntu and Windows with Node 24.
- The `grok`, `agy`, `claude` and `codex` in the tests are fake CLIs. The tests do not check real model quality, sign-in or image generation.
- The only real-model measurements are the [measured results](#measured-results) above.

License: [MIT](LICENSE).

## Inspired by

- [Orca](https://github.com/stablyai/orca), [Paseo](https://github.com/getpaseo/paseo): advisor/committee consults, line-level feedback, notifications
- [AnchorMind](https://github.com/jinho-von-choi/memento-mcp): memory-layer design (merging duplicates, contradiction review, decay, provenance)
- [cli-dispatch](https://github.com/rbinar/cli-dispatch): agy model-name checks, state injection after compaction, reading Codex quota
- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills): keeping the worker's claims from reviewers, finding categories
- [cursor/plugins pstack](https://github.com/cursor/plugins/tree/main/pstack): per-finding dispositions (Act on / Consider / Noted / Dismissed)
- [mattpocock/skills](https://github.com/mattpocock/skills): reviews split into standards and spec, task breakdown by dependency graph

# Acceptance integrity and agent guards

## Protect the original failing test

Write and commit the failing test before initializing the task. Add the following to the brief alongside its normal scope and acceptance commands:

```json
{
  "acceptance_commands": ["node check.test.mjs"],
  "verification": {
    "kind": "red-first",
    "protect": ["check.test.mjs"]
  }
}
```

The controller must observe a failing baseline. A green-baseline waiver is forbidden for this kind. Protected globs must match existing files; they may overlap scope, but the worker cannot modify them. The verification contract is fixed at init, including whether protection exists. A modified or deleted protected file produces `ACCEPTANCE_TEST_MODIFIED` and `RECOVERY_REQUIRED` before the controller executes acceptance commands. Recovery restores the expected tree; it does not grant permission to remove protection. Preserve verification retains its existing green-baseline and scope-disjoint rules.

Existing unprotected test/spec/check/verify paths and literal acceptance-command entrypoints are conservatively flagged when changed. Test scripts in `package.json` are also flagged for test/check/lint package commands. This is a file/command heuristic, not a dependency graph or proof that assertions became weaker; indirect helpers and unfamiliar test names may escape it. Newly added tests do not trigger this signal. Protect every input needed to preserve the original failure when stronger guarantees are required.

The changed paths appear in validation, review/consult acceptance context, VERIFY guidance and reports. Controller PASS is marked as lacking a trusted unchanged test baseline. Both classic automatic review adoption and delegated policy approval stop for lead review. CLOSE requires independent review of the current cumulative diff and an explicit `acceptance_test_change_reason` explaining why the modified evidence is still meaningful. An explicit lead decision can accept a legitimate test change; PASS alone cannot do so. Protected changes cannot be accepted with this reason.

## Secret reads

Claude's `--disallowedTools` and Grok's `--deny` include built-in `Read` restrictions for root/nested `.env`, `.env.*` and `secrets/**` paths during implementation, review and consultation. Protected files also receive Edit/Write denies. Prompts forbid secret reads through shell and search.

These tool rules are supplemental controls. They do not establish a filesystem boundary or stop every Bash, Grep, alternate tool, symlink or differently named secret file. Keep real credentials outside worker workspaces and use a host sandbox for stronger isolation. Masking transported briefs/diffs does not mask content a worker reads directly.

Current Codex supports configurable filesystem read-deny permissions, with platform/version limitations. HyperFusion's existing `--sandbox` adapter does **not** configure a read-deny permissions profile, so Codex workers may read workspace secrets. Do not treat this adapter as having path-based secret isolation. The capability needs a separately probed and tested integration before enabling it here. Official references: [Claude permissions](https://code.claude.com/docs/en/permissions), [Grok permissions](https://github.com/xai-org/grok-build/blob/main/docs/22-permissions-and-safety.md), [Codex permissions](https://developers.openai.com/codex/permissions), [Codex Windows sandbox](https://developers.openai.com/codex/windows).

## Observe hooks and guard active work

The Bash PreToolUse usage hook records its event and timestamp in `host-session.json`. Init captures a `hooks_observed` result before probing CLIs. A matching event no more than 15 seconds old counts as observed; absent, stale, future or non-Bash events produce `HOOKS_NOT_OBSERVED`. Doctor exposes the same observation; task state, reports and metrics retain the init observation. A recent usage event does **not** prove every guard hook is installed, that all commands are covered, or that future hooks will execute. Non-hook CLI hosts can proceed with this warning. Install the full `npm run guard:settings` snippet and verify deny output with an active disposable task.

The lead Bash hook blocks recognized `git commit`, `git push`, `git reset --hard`, forced `git clean`, recursive forced `rm`, and recursive forced PowerShell `Remove-Item` while the targeted repository has an active task, writer lease or acceptance lease. Literal `cd` and Git directory options are checked so an explicit target cannot bypass the current-directory check. After CLOSE/BLOCKED/ARCHIVED with no lease, this hook stops blocking these forms; publication still requires user authorization. This recognizer is not a complete shell parser or OS policy: arbitrary scripts, aliases, variable expansion and other API tools require host controls.

MCP tools (`mcp__*`) go through the same active-task and lease checks as `Edit`/`Write`, using the current directory's repository like the Bash hook. Only recognized read-only tools pass during active work: Serena symbol/search/read tools, GitHub MCP read tools (repository contents, commits, issues, pull requests, releases and CI runs/logs; no create, update, comment, merge, push, workflow-run or secret-scanning tools) and Context7 documentation lookups and Google Drive search/read tools (no create, update, copy, share or trash), under server names `serena`, `github`, `context7` and `google_drive`, their `plugin_<name>_<name>` forms and the claude.ai connector aliases in `MCP_SERVER_ALIASES` (full list in `MCP_READ_ONLY`, `scripts/lead-guard.mjs`), plus exact full names an operator lists in `HF_LEAD_MCP_ALLOW`. Servers registered under other names need that variable. Wildcards are not accepted. The check trusts tool names; it does not prove that an allowed tool only reads, or that an MCP server is confined to the current repository.

## English communication and instruction inventory

Every generated worker/reviewer/consultation prompt requires English instructions, plans, findings and structured reports. Identifiers, quoted source and project UI text keep their intended language. User-facing responses retain the user's preferred language. The contract records `communication_language:"en"`; other values are rejected. Natural-language compliance is instructed, not inferred or certified by a language detector.

Dispatch records repository instruction-file paths, status and SHA-256 hashes for `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` and `GEMINI.md`, including nested non-ignored files and common root files. Contents are not appended to the prompt. Deleted files and unavailable Git inventories are recorded explicitly; this is an inventory, not proof of what a particular CLI loaded. Brief scope and controller authority take precedence; conflicting repository instructions require a decision and cannot authorize commit/push/deploy or expanded scope.

Metrics include `rework_rate`, the share of recorded review outcomes that are `redo` or `alternative` (null when there are no reviews). This describes review iteration, not post-merge defects or human work time. Hook observations accompany usage data to help assess collection reliability.

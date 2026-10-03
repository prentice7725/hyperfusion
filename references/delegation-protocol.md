# Delegation contract

The lead owns every architectural choice. Use exact relative file or directory paths (no glob syntax), minimal relevant context and criterion IDs that stay stable across rounds. Include the current failure evidence and approved decisions in a fresh brief on redo. A persistent session is task-scoped; never reuse it for a new task or after host-session loss without recovery.

Example JSON (replace task and contents):
```json
{
  "task_id": "HF-20260914-001",
  "objective": "Fix duplicate refresh requests; auth refresh flow inspected by lead.",
  "scope": {"paths": ["src/auth", "tests/auth"], "allowed_expansion": "ask-lead"},
  "constraints": ["Preserve public API and existing uncommitted edits"],
  "success_criteria": ["AC1: concurrent callers share a single refresh", "AC2: rejection clears the in-flight state"],
  "allowed_actions": ["read", "edit", "test", "lint", "build"],
  "forbidden_actions": ["commit", "push", "deploy", "release", "scope-expansion"],
  "evidence_required": ["files_changed", "commands_run", "test_results", "remaining_risks"]
}
```

The adapter adds repo_root and round. Every scoped path includes its descendants. Tests with generated source outputs need those outputs in scope; ignored build caches are not audited. Do not approve ignored source-file edits. Snapshotting includes tracked and nonignored untracked files, symlink targets and permissions, plus HEAD and index fingerprints. Submodules are rejected in external M0.

For Claude, the optional claude_bash_rules field grants only narrowly selected Bash commands; see claude-runtime.md. Executor selection is recorded at init. A different executor receives current tree and approved decisions without transcripts. Luna receives only a bounded helper subtask after review.

# Codex CLI runtime

The adapter requires `exec --help` to advertise sandbox, cwd, output schema and JSONL. It separately probes `exec resume --help` for JSON/schema/model flags: unsupported resume stays stateless, never guessed. This conservative check may disable resume on CLIs whose parent flags work but are absent from resume help. No live CLI compatibility is claimed by fixtures.

Each implementation may persist its thread within one task; REDO targets that exact ID. Reviews/consultations start fresh in read-only mode and use `--ephemeral` when supported. `thread.started`, the final completed agent message and a completed turn are required. Error/failed/malformed/truncated events or mismatched session IDs fail the bridge. `turn.completed.usage` records input/output/cached input; input includes cached input, so total = input + output. Unknown usage remains null; no billed dollar estimate is inferred.

Official contracts: [non-interactive mode](https://developers.openai.com/codex/noninteractive), [CLI commands](https://developers.openai.com/codex/cli/reference), [configuration](https://developers.openai.com/codex/config-reference).

## Java/build caches: explicit operator opt-in

Workspace-write restricts writes outside the workspace; network availability also depends on the outer execution environment. To authorize dedicated Gradle/Maven cache directories, create them yourself and set `HF_CODEX_WRITABLE_ROOTS` to a JSON array of existing absolute directories, for example `["/opt/hf-cache/gradle","/opt/hf-cache/maven"]`. Set `HF_CODEX_NETWORK_ACCESS=1` only when network access is authorized; `0` explicitly disables it. These become `-c sandbox_workspace_write.writable_roots=...` / `network_access=...`. No directories are created automatically, and a filesystem root is rejected.

These environment options apply only to implementation, never read-only review/consultation. Repository executor options named `writable_roots`/`network_access` are not forwarded. External writable roots are outside snapshot coverage: keep them dedicated to build caches, never source or credential directories. They do not override host restrictions. Changing these options between begin and bridge changes the reconstructed dispatch and is refused. Existing Codex user configuration can still affect settings not explicitly overridden; do not treat cooperative control as complete isolation.

## Turn budgets

Claude/Grok retain the default `--max-turns 40`. Configure `executors.<member>.max_turns` or `max_turns_by_difficulty:{low:20,medium:40,high:80}` to change it (1–1000). Explicit max_turns takes precedence. Codex/AGY do not expose that contract here; such options are rejected. Supervisor wall-time and implementation round caps remain unchanged.

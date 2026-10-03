# Claude Code bridge

Use an installed, authenticated Claude Code CLI on POSIX. `HF_CLAUDE_BIN` may identify its executable path (including spaces); it is not a shell command or extra arguments. Doctor checks executable, version and required flags. It does not make a model call or verify credentials. Missing authentication is surfaced by the real invocation. Do not install software, copy credentials or change account settings merely to silence a failure.

external M0 uses `claude -p` with JSON Schema output, a preallocated UUID for the first session and `--resume` for later rounds. Read `structured_output`, validate both task/round and session identity, and preserve the full envelope. CLI failures, error envelopes, denied permissions, malformed JSON or invalid logical results cannot pass. Usage is a client-side estimate, not billed cost. These interfaces follow the [official programmatic guide](https://code.claude.com/docs/en/headless).

Use `--safe-mode` to avoid loading custom plugins, hooks, memory and instructions while retaining normal authentication and permissions; managed policy still applies. Explicitly pass relevant repository instructions in the brief. Restrict tools to file operations plus Bash, use `dontAsk`, and permit only selected Bash rules. No permission bypass, agent delegation or MCP tools. These flags are defined in the [official CLI reference](https://code.claude.com/docs/en/cli-reference); unsupported required flags fail preflight rather than weaken the configuration.

Optional brief field:
```json
{"claude_bash_rules":["Bash(node --test *)"]}
```
The lead chooses these from actual inspected test/build commands and existing authorization. An empty list grants no additional Bash approvals. Do not use blanket `Bash(*)` or grant deployment/commit commands. File edit tools are enabled only when allowed_actions contains edit. Tool rules and scope audits remain cooperative controls: they are not a path sandbox or a shell security verifier. A test script can itself mutate files; inspect the relevant scripts first.

The bridge launches without a shell, supplies the brief on stdin, caps each output stream at 8 MiB and limits a CLI call to ten minutes and 40 model turns. Timeout/interruption sends SIGTERM then SIGKILL to its POSIX process group. The bridge preserves launch PID, child PID/group, raw envelope and normalized result as per-round artifacts. A create-once launch marker blocks duplicate execution. Even on success the writer lease is retained until the lead confirms no escaped/detached descendants remain and calls finish. An unkillable or unverified process is blocked recovery, not permission to launch another writer.

Use node bridge process records to investigate an interruption. Never resume by “latest conversation,” create a fresh replacement for a lost session, or copy Luna transcripts into Claude. If an initial session never reached authentication, the stored resume may be unavailable; preserve and report the failure instead of manufacturing persistence.

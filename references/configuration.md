# Executor configuration

Read optional `hyperfusion.config.json` at the target repository root. If absent, use:
```json
{
  "lead": "sol",
  "lead_model": "gpt-6.1-sol",
  "lead_reasoning_effort": "high",
  "internal_helper": {"provider": "luna"},
  "external": {
    "default": "claude",
    "available": ["claude", "grok", "antigravity"]
  }
}
```

The invocation's `--executor` overrides the configured default for that task. The selected config is frozen in state at init; changes affect subsequent tasks, not an active lease. No permanent provider choice is embedded in orchestration logic. `available` is the user's enabled pool, not evidence that a CLI adapter exists. Capabilities and CLI presence are checked separately.

| Provider | Role | Implemented |
|---|---|---|
| Claude | External executor; default in shipped config | Yes, external M0 |
| Grok | External executor | Planned M1; unavailable |
| Antigravity | External executor | Planned M2; unavailable |
| auto | Lead selects using measured capabilities | Planned after M2; unavailable |
| Luna | Codex internal helper after review | Native tool descriptor |
| GPT-6.1 Sol (high) / Codex | Lead; code mutation only in takeover | Lead lease descriptor |

A future adapter must provide capability probing, task-scoped persistence, structured results, cancellation/process evidence and the same writer protocol. Do not guess Grok or Antigravity CLI names/flags. Auto-routing must consider capability, success evidence and Codex usage; it is not implemented by selecting the first installed executable.

Legacy `lead: astra` configuration is normalized to the Sol/high lead profile. Frozen running tasks and their leases are not rewritten. The target profile does not change the host model automatically; select GPT-6.1 Sol and high in the host when needed.

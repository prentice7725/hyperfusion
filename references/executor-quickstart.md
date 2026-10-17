# Executor quick reference

Read this short map first; load detailed references only at the current step.

1. Classic: plan → init → begin → bridge → finish → review → verify. Only CLOSE means success. Workers own mutation under a single writer lease; independent snapshots and acceptance checks prove results.
2. Projects: `project.mjs draft REPO` → fill planning fields → propose → user approve. Missing or policy-denied members cannot join. Milestone checkpoints require user acknowledgment.
3. Adaptive/v0.3: read [universal-supervisor](universal-supervisor.md) before init. Grants, mandatory review seats and the final lead gate are controller records, never worker/config authority. The implementer never reviews itself.
4. Failures: retain the lease until process shutdown is proven. Read [recovery](recovery-protocol.md); do not create replacement sessions or restart to evade attempt caps.

For a new Grok-enabled adaptive task, set criticality/strategy in the lead-approved brief at init and inspect `review_preview`. Standard work uses one independent reviewer; important/dual/risk-raised work uses the [cross-vendor pairs](review-pairs.md). Keep Grok implementation at medium and use xhigh only for its designated deep-review seat. Run the emitted review bridge once for independent parallel reviews; never turn a split or missing panel into PASS.

## Codex

Sol/Luna use `codex exec --json` and collect client-reported `turn.completed` usage. Cached input is already part of input; do not add it twice. Missing usage stays null. Implementation threads are task-scoped. Resume is enabled only if `exec resume --help` advertises the required JSON/schema/model flags, using the exact saved ID, never `--last`. Unsupported versions stay stateless while still collecting usage. Reviews remain read-only and ephemeral when supported. See [Codex runtime](codex-runtime.md).

## Egress policy

`allowed_vendors` narrows implementation, review and consultation together. `HF_ALLOWED_VENDORS` is an operator ceiling; repository configuration cannot widen it. Vendors are `anthropic`, `openai`, `xai`, `google`. Checks run at routing, selection and the bridge before spawning. This is cooperative dispatch control, not a network firewall/DLP or proof that a model override uses the built-in vendor. It does not govern the already-running host lead or CLI-internal MCP/proxy/network activity.

## Extension

[member-registry.mjs](../scripts/member-registry.mjs) owns built-in model/binary/vendor/capability/effort/budget/role metadata. CLI syntax, structured results, persistence, cancellation and provenance still require an audited adapter and tests. New model IDs on an existing CLI are configuration overrides, not arbitrary CLI support. Generic CLI/ACP adapters and full state-machine extraction are not implemented.

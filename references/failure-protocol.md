# Failure handling

Treat missing adapter/model, broken Git repository, schema errors, out-of-scope edits, changed HEAD/index, interrupted mutation and tree drift as explicit failures. Never convert them to success. Do not send commands after a result has ended a writer's writer authority.

A syntax or brief validation error before begin does not consume a round. Once a writer lease is issued, any dispatch error consumes it. Normal validation failures preserve raw result and snapshots; the lead must inspect and recover. Unexpected exceptions can leave partially recorded artifacts; use recovery, not a blind replay of finish/begin. control.lock uses exclusive creation to reject concurrent control commands. A crashed controller may leave it behind; see recovery-protocol.md.

No automatic reset --hard, clean, stash, branch checkout, commit, push or deletion. Do not pass credentials or whole conversation logs into briefs or audit artifacts. Metrics unavailable from the host stay null.

Claude bridge errors preserve the writer and per-round launch evidence. Do not rerun the bridge in the same round; resolve the cause and follow recovery. A denied command is not grounds to bypass permissions or retry it through another executor. Probe failures before begin consume no attempt.

Default external selection fails explicitly if absent; never start Luna or lead implementation as a silent fallback. An explicit takeover reason and lease are required for lead source edits. An unsuccessful takeover is BLOCKED.

# Review finding ledger (unreleased)

HF-I03 adds an observational ledger alongside immutable review artifacts. It does not participate in approval, delegated redo, required reviewer selection, or digest validation. Original rejections and every reviewer seat remain authoritative.

## Inspect and forward

Run `node scripts/fusion-state.mjs findings REPO` for a bounded unresolved summary. Supply a JSON input containing `{"full":true}` through the CLI's usual input argument to inspect all observations and raw artifact pointers. `node scripts/fusion-state.mjs revision-packet REPO` builds a read-only correction packet. Neither inspection launches a model or changes task state.

On an authorized redo, `begin` accepts `lead_feedback:"@findings"` to explicitly forward that packet and save `revision-packet-N.json`. Existing `@review` behavior remains unchanged. The packet includes at most 16 findings, 12 blocking criteria and eight acceptance feedback items; omitted counts and raw source pointers require lead inspection when evidence is truncated. CLI consult summaries show counts instead of repeating complete reviewer results; full output and raw artifacts remain available.

## Grouping and locations

Only exact matches of AC IDs, normalized path, line, reviewed digest, file hash, issue text hash and evidence hash share a display entry. Different evidence, wording, unknown locations and different digests stay separate. Verdict or severity disagreements are visible. Grouping never counts as reviewer agreement or reduces the required panel.

At review settlement the controller may capture hashes of up to five source lines around a finding. Reads are limited to scoped ordinary files matching the snapshot, under 256 KiB, without symlink traversal, binary content or recognized secret paths such as `.env`. Source text is not stored in context records. A later finish maps the location only when the original context was unique and has exactly one match in the new file. Ambiguous or missing matches require relocation and current review. An unchanged file is not proof that a finding was fixed.

Context and location sidecars are presentation metadata. Raw review files reconstruct the ledger; missing or invalid metadata cannot remove a rejection. An observation failure does not change the controller's approval decision. There is no semantic/model deduplication, review-scope cache or automatic resolution.

## Lead dispositions

`lead-decision` may carry `finding_dispositions` that classify current-round findings as `act`, `consider`, `noted`, `dismissed` or `contract_misread`, each with a reason ([review-protocol](review-protocol.md)). The `@findings` packet omits `dismissed`/`noted` issues (listed in `withheld_by_lead`) and annotates the rest with the lead's note; blocking criteria are still forwarded. Dispositions do not change ledger `disposition`, approval or panel requirements.

## Record a fix

`resolve-finding` accepts `{"finding_id":"F-…","reason":"…"}` using the normal JSON input argument. It requires a settled prior-digest finding with AC IDs, a current unchanged tree, new passing controller acceptance commands covering every finding AC with process shutdown proof, unchanged acceptance inputs, and current-digest review approval. It records an immutable annotation and does not approve or advance the task. Repeating the same annotation is idempotent. Changed evidence or a later round makes the annotation stale and the finding unresolved again.

Local fake-CLI tests cover grouping, evidence conflicts, conservative line mapping, corrupt metadata, bounded packets, resolution evidence and preservation of mandatory paired review. Live model token savings and the full platform CI matrix have not been measured for this feature.

Directory names are read and sorted once per ledger call, then indexed by finding ID for resolution annotations. Every annotation and its acceptance/review hashes are still read and validated on each call; nothing is cached across inspections. Sorted resolution selection, stale-evidence warnings and raw reviewer observations are unchanged.

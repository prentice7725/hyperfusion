# Bounded memory recall

Memory remains advisory. A recalled fragment grants no execution authority and
must be checked against the current source of truth and Git before inclusion in
`brief.prior_experience`.

Use `node scripts/memory.mjs recall REPO "query" --limit 8 --byte-budget 12000`
to opt into a bounded retrieval packet. `byte_budget` bounds the UTF-8 JSON
packet returned by `retrievalPacket`, not the surrounding CLI response or a
model-specific token count. The CLI also returns workspace, query and confirmed
inclusion guidance; account for that wrapper separately when building prompts.

Whole content entries are omitted rather than summarized. `omitted` retains
fragment pointers and unresolved `conflicts_with` IDs. Resolve pointers in the
bound workspace store; a fragment ID alone does not authorize access to another
workspace. If even the pointers exceed the budget, narrow the query or increase
the budget. No contradictory item is promoted into `prior_experience`.

Bounded recall does not increment legacy recall counters or reinforce ranking.
Retrieval is not proof of inclusion or usefulness. The normal recall API remains
available; its total hit count now respects `limit` (1–100), and association
expansion respects the same type and keyword filters as direct matches.

## Source context and candidate review

Candidates and explicit lead additions may carry optional `provenance`:

```json
{"task":"HF-example","version":"2.0","artifact":{"path":"docs/design.md","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
```

Fields are optional; artifact pointers require both a repository-relative path
and a lowercase SHA-256. Context is caller-supplied and unvalidated. Recall shows
that warning and any expiry date. Compare it with current SOT/Git yourself.
Pass a provenance JSON file with `--provenance INPUT.json` to require exact
matches for the fields supplied. Missing or obsolete context is excluded from
hits and association expansion. Contradiction markers remain visible even when
the contexts differ. Identical text from different contexts is kept separately.
Without explicit artifact checking, pointers do not cause file reads. A memory's
artifact pointer never causes command execution.

Opt in to local artifact checking with `--validate-artifacts`. This hashes the
referenced repository file and removes changed, missing, unreadable, linked or
oversized sources from hits and `prior_experience`. `invalidated` retains their
fragment pointers and reason codes, including in bounded packets. Quarantined
contradictions remain visible. Memories with no artifact pointer remain visible
as `artifact_unknown`; a matching hash proves identity, not correctness.
Checking does not alter or delete stored memories and does not reinforce recall
ranking. Observed retrieval counts exclude invalidated items.

Checks reject unsafe paths, Git metadata, symlinks/junctions and files over 8 MiB.
They inspect the current filesystem and are cooperative controls, not a sandbox
against concurrent filesystem substitution. Use them on a settled source tree.

`node scripts/memory.mjs review REPO [TASK] --limit 20` returns up to 20 pending
candidates (maximum 100), a remaining count and `ledger_digest`. It is read only.
Explicitly submit `accept`/`reject` candidate IDs through the existing `commit`
command with `expected_digest` set to that value. The controller lock protects
the comparison and mutation; any intervening ledger change rejects the whole
stale submission before additions or decisions. No automatic approval occurs.
Historical candidates are conservatively inferred; a verification file alone
does not establish that a past task reached CLOSE.

## Observations

Add `--observe` to recall to record a task-local retrieval receipt and receive
`retrieval_id`. It stores fragment IDs and content fingerprints, not queries or
recalled content. Only hits actually returned in the packet count; omitted and
quarantined entries do not. Tracking is opt in, with a maximum of 1,000 retrievals
per task. Legacy recall counts are not used as a usefulness signal.

Task metrics expose `memory`: observed retrieval events/items, actual inclusion
in saved `brief-N.json` files, and separate lead-reported usefulness assessments.
No retrieval observations means unknown (`null`), not zero. Brief inclusion does
not prove that a process launched, used the advice or benefited from it.

Use `node scripts/memory.mjs assess REPO INPUT.json` with:

```json
{"task":"HF-example","retrieval_id":"receipt UUID","id":"fragment ID","round":1,"outcome":"helpful","evidence":"The diagnostic matched the observed failure."}
```

Outcomes are `helpful`, `unhelpful` or `unknown`. A report requires non-secret
evidence, a receipt from the bound workspace and the same ID/type/content in the
saved round brief. Paraphrases require a new retrieval; semantic equivalence is
not inferred. Resubmitting the same receipt/item/round replaces its assessment
instead of counting twice. Assessments are capped at 1,000 per task. Reports are
observations, never execution authority or causal proof of task success.

Rerun the existing metrics command after adding assessments to refresh a saved
task metrics record. Aggregated success/cost rates do not infer memory impact.

No embeddings, automatic approvals or semantic equivalence claims are introduced.

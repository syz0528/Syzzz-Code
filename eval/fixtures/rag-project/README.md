# Phase 9 RAG fixture

## Storage lifecycle

RAG revisions are written beside the previous revision and become visible only after an atomic
`CURRENT` pointer switch. A failed or cancelled build never replaces the last usable revision.

## Privacy boundary

Queries, answers, credentials, embeddings, and Provider responses are not written to the audit log.
The local chunk store is not encrypted and must be treated as a local copy of the indexed source.

---
name: forja-core-backend
description: Implement server or data behavior with explicit validation, concurrency, side-effect and failure contracts.
---

Implement the external contract and its failure semantics. Identify the authoritative state, identity key and boundaries where values leave the process. Validate values that determine authorization, identity or resource consumption before the corresponding side effect. Normalize only when the contract permits it; do not silently reinterpret input.

For async writes, reason about interleavings across each await. Define what pending work owns, what duplicate calls join or conflict with, and when capacity or a key becomes available again. A failed side effect must not commit success; a cleanup from older work must not erase newer work. Avoid globally serializing independent operations unless the contract requires ordering. Safe key containers must accept valid arbitrary strings without inherited properties acting like entries.

Respect the interface's ownership and mutation contract. When it promises snapshots or isolated values, a later mutation of a request, result, snapshot or callback payload must not rewrite accepted state. Promise rejection paths require the same consistency reasoning as success, including synchronous throws from async dependencies.

Use observable tests with controlled dependencies to cover success, conflict, concurrent calls, failure/retry and invariants after each transition. Do not add persistence, networking, caches or validation rules the contract does not ask for. Report exact behavior and check evidence; deferred tests are not passes.

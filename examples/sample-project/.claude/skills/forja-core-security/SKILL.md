---
name: forja-core-security
description: Implement or review a change that crosses an actual trust boundary, such as user or tenant authorization, untrusted content reaching an interpreter, filesystem access or secret handling. Use for relevant security work, not as an automatic audit of every task.
---

Identify the boundary changed by this task: who controls the input, which
operation or data it can reach, and what authority the caller actually has.
Read the enforcement path and its call sites; a label such as internal, escaped
or authenticated does not establish a guarantee. Apply the supplied deployment
and attacker assumptions rather than expanding them silently.

Follow untrusted values to the operation that uses them. Authorization must
cover the requested resource and action at the authoritative boundary; knowing
an identifier or passing validation is not permission. For interpreter sinks,
use the destination's data interface or escaping rules. Protection for one
context is not automatically protection for another. Keep secrets and unrelated
private input out of diagnostics and test artifacts.

For each suspected defect, construct the smallest permitted input and sequence
that bypasses the intended boundary. Compare it with a valid request. Establish
reachability and consequence from code or an isolated check before claiming an
exploit. Clearly separate a demonstrated flaw, an unverified assumption and an
optional hardening measure. Do not reject correct code for hypothetical
infrastructure or attack capabilities excluded by the contract.

Keep remediation within the actual boundary and preserve legitimate behavior.
Test the attempted bypass and a positive case, plus a relevant alternate path
when it could escape the same enforcement. A readonly review returns actionable
findings and evidence without changing files. Existing task permissions govern
execution; this skill grants no permission to probe live systems or disclose
data. Report any material observation that the available tools cannot verify.

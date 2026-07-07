# Changelog

## [Unreleased] — operational-safety hardening

Hardened against the Agent Flight Rules (AFR) Boldface controls after a Runworthy
scan. All changes are additive and covered by tests (95 passing).

### Security
- **Dependencies (AFR-10):** regenerated `package-lock.json` to patched
  transitive versions; `npm audit` and `osv-scanner` are now clean. Runtime deps
  pinned to exact versions.
- **Kill-switch (AFR-20):** `cascade-engine halt/resume` and `CASCADE_HALT` refuse
  all tool calls immediately; `cascade-engine abort <id>` stalls one cascade.
  Enforced by a guard every tool funnels through.
- **Approval gate (AFR-12):** high-consequence steers (`redirect`, `reject`,
  `drop_hypothesis`) no longer auto-apply — they wait for `apply_steer`. `reject`
  and quarantine-rejection now write a **reversible tombstone** instead of a hard
  `DELETE`, preserving the audit trail.
- **Consequence classification (AFR-11):** every tool and steer is tiered
  low/high/critical in `src/safety/policy.ts`; the gate reads it directly.
  Unknown types default-deny (AFR-14).
- **Action log (AFR-16):** every tool invocation is recorded to `action_log`
  (`cascade-engine actions`, `get_actions`).
- **Anomaly interventions (AFR-17):** `budget_overrun` and `quarantine_spike`
  raise blocking interventions; a dependency-free `CircuitBreaker` primitive was
  added (the one the spec described but never implemented).
- **Least privilege (AFR-04):** per-role `tools:` allowlists on the four agents.

### Docs
- `SECURITY.md`, `docs/agent-registry.md` (AFR-01), `docs/consequence-classification.md`,
  `docs/incident-runbook.md` (AFR-25), `docs/dependency-policy.md` (AFR-09).

## [0.2.1] — security patch
- Dependency security patch (published to npm).

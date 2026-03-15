---
name: cascade-methodology
description: Research Cascade Protocol — progressive deep research with quality gates
version: 0.1.0
---

## Research Cascade Protocol

Use this protocol when conducting deep, multi-round research on any topic. The cascade engine tracks state in SQLite — findings survive context compaction.

### Steps

1. **Initialize:** `cascade_init` with research question → creates cascade ID
2. **Plan:** `store_plan` with questions + success criteria → locks research plan (immutable)
3. **Check status:** `get_status` → current phase, round, findings count
4. **Research:** For each question:
   - Use `web_search` to find sources
   - Use `web_fetch` to read promising results
   - Use `store_finding` for each discovery (structured claim + evidence + source)
5. **Build graph:** `add_entity` for key concepts, `add_link` for relationships
6. **Hypothesize:** `store_hypothesis` for testable claims derived from findings
7. **Advance:** `update_status` with advance_round=true to start next round
8. **Quality check:** `get_metrics` for coverage/depth/confidence dashboard
9. **Steer if needed:** `steer` to redirect, narrow, broaden, add questions
10. **Synthesize:** When stopping gates trigger, produce final analysis

### Rules

- Always `get_status` before starting work — may have pending steer events
- Never skip `store_finding` — findings lost to compaction are unrecoverable
- Record `record_metric` for entropy/coverage after each round
- Check `get_hypotheses` to avoid duplicating existing hypotheses
- Use `store_checkpoint` before any risky operation

### Quality Gates

The engine checks stopping conditions automatically:
- Max rounds reached
- Token budget exhausted
- Diminishing returns (new findings < 30% of previous round)
- Confidence convergence (average > 85%)
- Entropy floor (knowledge graph structure stabilized)

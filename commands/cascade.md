---
description: Run a research cascade — progressive deep research with quality gates and knowledge graph
---

# /cascade command

Start or manage a research cascade. The cascade system provides:
- Multi-round iterative research with quality gates
- Knowledge graph that builds connections between findings
- Trust scoring to filter unreliable information
- PID self-regulation for optimal search strategy
- Step-level checkpointing for crash recovery

## Usage

`/cascade research <question>` — Start a new research cascade
`/cascade status [id]` — Check cascade progress
`/cascade steer <id> <instruction>` — Redirect active research
`/cascade quality <id>` — View quality dashboard

## Workflow

1. Initialize cascade with `cascade_init`
2. Lock a research plan with `store_plan` (prevents changing criteria mid-research)
3. Delegate research to sub-agents (research-planner, deep-investigator, cross-validator)
4. After each round, synthesis-writer produces round summary
5. Quality gates decide whether to continue or stop
6. On completion, export final analysis

## Rules

- Always check `get_status` before starting work
- Store every finding with `store_finding` — they survive context compaction
- Build the knowledge graph as you go — entities and links compound value
- Check for pending steer events at the start of each iteration

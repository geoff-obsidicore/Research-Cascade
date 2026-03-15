---
name: knowledge-graph
description: Build and query the knowledge graph during research
version: 0.1.0
---

## Knowledge Graph Protocol

Build a knowledge graph as you research. Entities are concepts, tools, people, techniques. Links capture relationships between them.

### Entity Types

- `concept` — abstract ideas, theories, approaches
- `tool` — software, frameworks, libraries
- `person` — researchers, authors, contributors
- `technique` — algorithms, methods, patterns
- `paper` — academic papers, publications
- `finding` — validated research findings
- `problem` — unsolved issues, gaps

### Relationship Types

- `relates_to` — general association
- `supports` — evidence supporting a claim
- `contradicts` — evidence against a claim
- `uses` — tool/technique dependency
- `part_of` — compositional relationship
- `causes` — causal relationship
- `implements` — concrete implementation of concept
- `extends` — builds upon previous work

### Best Practices

1. Extract entities as you store findings — every finding should generate 2-3 entities
2. Always create bidirectional relationships where appropriate
3. Use `query_graph` to find connections before researching new topics
4. Watch for high-betweenness entities — they bridge knowledge domains
5. Entities in different communities with no direct link = research frontier

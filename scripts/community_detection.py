#!/usr/bin/env python3
"""Community detection and betweenness centrality for the Research Cascade knowledge graph.

Reads kg_entities and kg_edges from the SQLite database, runs Leiden clustering
and betweenness centrality (cutoff=3) via igraph, and writes community_id +
betweenness back to kg_entities.

Install: pip install igraph   (NOT python-igraph — deprecated name)
"""

import argparse
import os
import sqlite3
import sys
from pathlib import Path


def get_default_db_path() -> str:
    """Return ~/.cascade-engine/knowledge.db, expanded for the current OS."""
    return str(Path.home() / ".cascade-engine" / "knowledge.db")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run Leiden community detection and betweenness centrality on the knowledge graph.",
    )
    parser.add_argument(
        "--db-path",
        default=get_default_db_path(),
        help="Path to the SQLite knowledge database (default: ~/.cascade-engine/knowledge.db)",
    )
    return parser.parse_args()


def load_graph(db_path: str):
    """Load entities and edges from SQLite; return (igraph.Graph, id_list).

    id_list maps igraph vertex indices back to kg_entities.id values.
    Returns (None, []) for an empty graph.
    """
    try:
        import igraph as ig
    except ImportError:
        print(
            "ERROR: igraph is not installed. Install with:  pip install igraph",
            file=sys.stderr,
        )
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        entities = conn.execute("SELECT id, name, entity_type FROM kg_entities ORDER BY id").fetchall()
        if not entities:
            return None, []

        # Map kg_entities.id → igraph vertex index
        id_to_idx = {row["id"]: idx for idx, row in enumerate(entities)}
        id_list = [row["id"] for row in entities]
        names = [row["name"] for row in entities]

        edges_raw = conn.execute(
            "SELECT source_id, target_id, weight FROM kg_edges"
        ).fetchall()

        edge_tuples = []
        weights = []
        for e in edges_raw:
            src = id_to_idx.get(e["source_id"])
            tgt = id_to_idx.get(e["target_id"])
            if src is not None and tgt is not None:
                edge_tuples.append((src, tgt))
                weights.append(e["weight"] if e["weight"] is not None else 1.0)

        g = ig.Graph(n=len(entities), edges=edge_tuples, directed=False)
        g.vs["db_id"] = id_list
        g.vs["name"] = names
        if weights:
            g.es["weight"] = weights

        return g, id_list
    finally:
        conn.close()


def run_leiden(g):
    """Run Leiden community detection (resolution=1.0). Returns membership list."""
    return g.community_leiden(
        objective_function="modularity",
        resolution=1.0,
        weights="weight" if "weight" in g.es.attributes() else None,
    )


def run_betweenness(g):
    """Compute betweenness centrality with cutoff=3. Returns list of floats."""
    return g.betweenness(cutoff=3, weights=None)


def write_results(db_path: str, id_list: list, membership: list, betweenness: list):
    """Write community_id and betweenness back to kg_entities."""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA busy_timeout = 10000")
        rows = [
            (int(membership[i]), float(betweenness[i]), id_list[i])
            for i in range(len(id_list))
        ]
        conn.executemany(
            "UPDATE kg_entities SET community_id = ?, betweenness = ? WHERE id = ?",
            rows,
        )
        conn.commit()
    finally:
        conn.close()


def print_summary(g, membership, betweenness, id_list):
    """Print summary statistics: community count, sizes, top bridge nodes."""
    n_vertices = g.vcount()
    n_edges = g.ecount()
    communities = set(membership)
    n_communities = len(communities)

    print(f"Graph: {n_vertices} nodes, {n_edges} edges")
    print(f"Communities found: {n_communities}")

    # Community size distribution
    sizes = {}
    for cid in membership:
        sizes[cid] = sizes.get(cid, 0) + 1
    sorted_sizes = sorted(sizes.values(), reverse=True)
    top_5 = sorted_sizes[:5]
    print(f"Largest communities (top 5): {top_5}")

    # Top bridge nodes (highest betweenness)
    indexed = sorted(
        enumerate(betweenness), key=lambda x: x[1], reverse=True
    )
    n_top = min(10, len(indexed))
    print(f"\nTop {n_top} bridge nodes (highest betweenness):")
    print(f"  {'Rank':<5} {'Name':<40} {'Community':<10} {'Betweenness':>12}")
    print(f"  {'-'*5} {'-'*40} {'-'*10} {'-'*12}")
    for rank, (idx, btwn) in enumerate(indexed[:n_top], 1):
        name = g.vs[idx]["name"]
        cid = membership[idx]
        print(f"  {rank:<5} {name:<40} {cid:<10} {btwn:>12.4f}")


def main():
    args = parse_args()
    db_path = args.db_path

    if not os.path.isfile(db_path):
        print(f"ERROR: Database not found: {db_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Loading graph from: {db_path}")
    g, id_list = load_graph(db_path)

    if g is None or g.vcount() == 0:
        print("Graph is empty — nothing to compute.")
        sys.exit(0)

    print(f"Running Leiden community detection (resolution=1.0) ...")
    partition = run_leiden(g)
    membership = partition.membership

    print(f"Computing betweenness centrality (cutoff=3) ...")
    betweenness = run_betweenness(g)

    print(f"Writing results back to kg_entities ...")
    write_results(db_path, id_list, membership, betweenness)

    print()
    print_summary(g, membership, betweenness, id_list)
    print("\nDone.")


if __name__ == "__main__":
    main()

/**
 * NCD (Normalized Compression Distance) — Deduplication
 *
 * NCD(x,y) = [C(xy) - min(C(x),C(y))] / max(C(x),C(y))
 * Using zlib deflate as compressor.
 *
 * < 0.3 = redundant (deduplicate)
 * 0.3-0.7 = related (link in graph)
 * > 0.7 = novel (keep as separate finding)
 */

import { deflateSync } from 'node:zlib';

/**
 * Compute NCD between two strings.
 */
export function ncd(x: string, y: string): number {
  const bx = Buffer.from(x, 'utf-8');
  const by = Buffer.from(y, 'utf-8');
  const bxy = Buffer.from(x + y, 'utf-8');

  const cx = deflateSync(bx).length;
  const cy = deflateSync(by).length;
  const cxy = deflateSync(bxy).length;

  const minC = Math.min(cx, cy);
  const maxC = Math.max(cx, cy);

  if (maxC === 0) return 0;
  return (cxy - minC) / maxC;
}

/**
 * Classify the relationship between two texts based on NCD.
 */
export function classifyRelation(distance: number): 'redundant' | 'related' | 'novel' {
  if (distance < 0.3) return 'redundant';
  if (distance < 0.7) return 'related';
  return 'novel';
}

/**
 * Find near-duplicates in a set of claims.
 * Returns clusters of redundant claims.
 */
export function findDuplicateClusters(
  claims: { id: string; text: string }[],
  threshold: number = 0.3,
): Map<string, string[]> {
  const clusters = new Map<string, string[]>();
  const assigned = new Set<string>();

  for (let i = 0; i < claims.length; i++) {
    if (assigned.has(claims[i].id)) continue;

    const cluster = [claims[i].id];
    assigned.add(claims[i].id);

    for (let j = i + 1; j < claims.length; j++) {
      if (assigned.has(claims[j].id)) continue;

      const distance = ncd(claims[i].text, claims[j].text);
      if (distance < threshold) {
        cluster.push(claims[j].id);
        assigned.add(claims[j].id);
      }
    }

    if (cluster.length > 1) {
      clusters.set(claims[i].id, cluster);
    }
  }

  return clusters;
}

/**
 * Deduplicate findings for a cascade round.
 * Keeps the highest-confidence finding from each cluster.
 */
export function deduplicateFindings(
  findings: { id: string; claim: string; confidence: number }[],
  threshold: number = 0.3,
): { kept: string[]; removed: string[]; clusters: number } {
  const clusters = findDuplicateClusters(
    findings.map(f => ({ id: f.id, text: f.claim })),
    threshold,
  );

  const removed: string[] = [];
  const kept: string[] = [];

  for (const [_leaderId, clusterIds] of clusters) {
    // Find highest confidence in cluster
    const clusterFindings = findings.filter(f => clusterIds.includes(f.id));
    clusterFindings.sort((a, b) => b.confidence - a.confidence);

    kept.push(clusterFindings[0].id);
    for (let i = 1; i < clusterFindings.length; i++) {
      removed.push(clusterFindings[i].id);
    }
  }

  // Add unclustered findings to kept
  for (const f of findings) {
    if (!kept.includes(f.id) && !removed.includes(f.id)) {
      kept.push(f.id);
    }
  }

  return { kept, removed, clusters: clusters.size };
}

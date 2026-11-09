/**
 * Builds a sorted tree from flat rows with `parentId`. Rows whose parent is
 * missing (hidden or deleted) are dropped together with their subtree, so
 * hiding a column also hides its links.
 */
export function buildTree<T extends { id: string; parentId: string | null; position: number }, N>(
  rows: readonly T[],
  map: (row: T, children: N[]) => N | null,
): N[] {
  const byParent = new Map<string | null, T[]>();
  for (const row of rows) {
    const list = byParent.get(row.parentId) ?? [];
    list.push(row);
    byParent.set(row.parentId, list);
  }
  const build = (parentId: string | null, depth: number): N[] => {
    if (depth > 8) return []; // guards against accidental cycles in admin data
    const children = (byParent.get(parentId) ?? []).sort((a, b) => a.position - b.position);
    const out: N[] = [];
    for (const row of children) {
      const node = map(row, build(row.id, depth + 1));
      if (node) out.push(node);
    }
    return out;
  };
  return build(null, 0);
}

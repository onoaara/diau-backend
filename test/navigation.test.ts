import { describe, expect, it } from "vitest";
import { safeHref } from "../src/core/href";
import { buildTree } from "../src/lib/tree";
import { escapeLike, toPrefixTsQuery, tokenize } from "../src/search/query";

describe("safeHref", () => {
  it.each([
    ["/deals", "/deals"],
    ["  /c/electronics ", "/c/electronics"],
    ["https://example.com/a", "https://example.com/a"],
    ["mailto:hi@diau.test", "mailto:hi@diau.test"],
    ["#main", "#main"],
  ])("allows %s", (input, out) => expect(safeHref(input)).toBe(out));

  it.each(["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "//evil.test", "/\\evil.test", "", null, "not a url"])(
    "rejects %s",
    (input) => expect(safeHref(input)).toBeNull(),
  );
});

describe("buildTree", () => {
  const rows = [
    { id: "b", parentId: null, position: 1 },
    { id: "a", parentId: null, position: 0 },
    { id: "a1", parentId: "a", position: 0 },
    { id: "orphan", parentId: "hidden", position: 0 },
  ];
  type N = { id: string; children: N[] };
  it("nests, sorts by position and drops orphans", () => {
    const tree = buildTree<(typeof rows)[number], N>(rows, (r, children) => ({ id: r.id, children }));
    expect(tree).toEqual([{ id: "a", children: [{ id: "a1", children: [] }] }, { id: "b", children: [] }]);
  });
  it("lets the mapper drop a node and its subtree", () => {
    const tree = buildTree<(typeof rows)[number], N>(rows, (r, children) => (r.id === "a" ? null : { id: r.id, children }));
    expect(tree.map((n) => n.id)).toEqual(["b"]);
  });
});

describe("search query helpers", () => {
  it("builds prefix tsqueries from words only", () => {
    expect(toPrefixTsQuery("Apple  lapt")).toBe("apple:* & lapt:*");
    expect(toPrefixTsQuery("it's 4K!")).toBe("it:* & s:* & 4k:*");
    expect(toPrefixTsQuery("'); DROP TABLE x; --")).toBe("drop:* & table:* & x:*");
    expect(toPrefixTsQuery("!!!")).toBeNull();
  });
  it("keeps non-latin words", () => expect(tokenize("café Ñandú")).toEqual(["café", "ñandú"]));
  it("escapes LIKE wildcards", () => expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\"));
});

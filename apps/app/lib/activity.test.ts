import { describe, expect, test } from "bun:test";

import { pageOf } from "./activity";

/**
 * The activity table showed `.slice(0, 10)` — a list that silently ended, with no sign an
 * eleventh row existed. Paging it means an index, and an index over data that shrinks is how a
 * reader ends up on a page that no longer exists: no rows, no error, and it reads as "nothing
 * ever happened".
 */
describe("which slice a page is", () => {
  test("an empty list still has one page, not zero", () => {
    expect(pageOf(0, 0, 10)).toEqual({
      pages: 1,
      current: 0,
      from: 0,
      count: 0,
    });
  });

  test("exactly one page's worth is one page", () => {
    expect(pageOf(10, 0, 10).pages).toBe(1);
  });

  test("one more than that is two", () => {
    expect(pageOf(11, 0, 10).pages).toBe(2);
  });

  test("the last page holds the remainder, not a full page", () => {
    expect(pageOf(23, 2, 10)).toEqual({
      pages: 3,
      current: 2,
      from: 20,
      count: 3,
    });
  });

  // The case that strands a reader: they were on page 4, then the list came back shorter.
  test("a page past the end clamps to the last one and still has rows", () => {
    const p = pageOf(12, 9, 10);
    expect(p.current).toBe(1);
    expect(p.from).toBe(10);
    expect(p.count).toBe(2);
  });

  // And the same list going empty must not ask for rows from offset 90.
  test("a page past the end of an empty list asks for nothing", () => {
    expect(pageOf(0, 9, 10)).toEqual({
      pages: 1,
      current: 0,
      from: 0,
      count: 0,
    });
  });

  test("a negative page is the first one", () => {
    expect(pageOf(30, -3, 10).current).toBe(0);
  });
});

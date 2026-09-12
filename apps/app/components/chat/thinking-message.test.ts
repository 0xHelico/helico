import { expect, test } from "bun:test";

import { ORB_STATES, orbStateFor } from "@/components/chat/thinking-message";

// **The point of the whole thing.** A wait begins once the person's own message is on screen, so
// the turn count is odd every time: 1, 3, 5, 7. Stepping by two through nine has to land on every
// state before coming back, or some of them would never be seen and some would repeat early.
test("consecutive waits never show the same orb twice running", () => {
  const seen = [1, 3, 5, 7, 9, 11, 13, 15, 17].map(orbStateFor);
  expect(new Set(seen).size).toBe(ORB_STATES.length);
  for (let i = 1; i < seen.length; i++) {
    expect(seen[i]).not.toBe(seen[i - 1]);
  }
  // And the tenth wait is where it started, which is a cycle rather than a coincidence.
  expect(orbStateFor(19)).toBe(seen[0]);
});

test("every state is one the package ships", () => {
  for (let n = 0; n < 40; n++) {
    expect(ORB_STATES).toContain(orbStateFor(n));
  }
});

// A fresh conversation and a negative count both have to resolve to a real state rather than to
// undefined, which would render an orb with no animation at all.
test("it answers for a count nobody expected", () => {
  expect(ORB_STATES).toContain(orbStateFor(0));
  expect(ORB_STATES).toContain(orbStateFor(-1));
  expect(ORB_STATES).toContain(orbStateFor(1_000_003));
});

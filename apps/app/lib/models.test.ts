import { describe, expect, test } from "bun:test";
import { KNOWN_MODELS, modelChoices } from "./models";

describe("modelChoices", () => {
  test("every model the backend reports is selectable, and only those", () => {
    const choices = modelChoices(["gpt-4o-mini", "gemini-pro-agent"]);
    expect(choices.filter((m) => m.available).map((m) => m.id)).toEqual([
      "gpt-4o-mini",
      "gemini-pro-agent",
    ]);
    expect(choices.length).toBe(KNOWN_MODELS.length);
  });

  // Otherwise the picker would offer a menu of things that silently do nothing.
  test("nothing is selectable when no model is configured", () => {
    expect(modelChoices([]).some((m) => m.available)).toBe(false);
  });

  test("a model the list has never heard of is still shown, and is enabled", () => {
    const choices = modelChoices(["some-private-router/llama-4"]);
    expect(choices[0]?.id).toBe("some-private-router/llama-4");
    expect(choices[0]?.available).toBe(true);
    expect(choices.filter((m) => m.available)).toHaveLength(1);
  });

  // The two Helico actually serves both have a name and a mark in this file, so neither falls
  // through to "Configured" with a routing string for a label.
  test("both of the configured models are known by name", () => {
    for (const id of ["gpt-4o-mini", "gemini-pro-agent"]) {
      const row = KNOWN_MODELS.find((m) => m.id === id);
      expect(row?.provider).toBeTruthy();
      expect(row?.name).not.toBe(id);
    }
  });
});

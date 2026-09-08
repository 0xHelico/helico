import { describe, expect, test } from "bun:test";
import { KNOWN_MODELS, modelChoices } from "./models";

describe("modelChoices", () => {
  test("only the model the backend reports is selectable", () => {
    const choices = modelChoices("gpt-4o-mini");
    expect(choices.filter((m) => m.available).map((m) => m.id)).toEqual([
      "gpt-4o-mini",
    ]);
    expect(choices.length).toBe(KNOWN_MODELS.length);
  });

  // Otherwise the picker would offer a menu of things that silently do nothing.
  test("nothing is selectable when no model is configured", () => {
    expect(modelChoices(null).some((m) => m.available)).toBe(false);
  });

  test("a model the list has never heard of is still shown, and is the enabled one", () => {
    const choices = modelChoices("some-private-router/llama-4");
    expect(choices[0].id).toBe("some-private-router/llama-4");
    expect(choices[0].available).toBe(true);
    expect(choices.filter((m) => m.available)).toHaveLength(1);
  });
});

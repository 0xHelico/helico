/**
 * What the picker offers.
 *
 * `apps/be` talks to one OpenAI-compatible endpoint and answers with the model it is actually
 * configured for. That one is selectable. Everything else here is listed and **disabled**: it
 * says what could be wired, and says plainly that it is not — which is the opposite of claiming
 * it works.
 */
export type KnownModel = {
  id: string;
  name: string;
  provider: string;
};

export const KNOWN_MODELS: KnownModel[] = [
  { id: "gpt-4o-mini", name: "GPT-4o mini", provider: "OpenAI" },
  { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 mini", provider: "OpenAI" },
  { id: "deepseek-chat", name: "DeepSeek V3", provider: "DeepSeek" },
  { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", provider: "Meta" },
  { id: "qwen2.5-72b-instruct", name: "Qwen2.5 72B", provider: "Alibaba" },
];

/** The list to render: whatever the backend serves comes first and is the only enabled one. */
export function modelChoices(active: string | null) {
  const known = KNOWN_MODELS.some((m) => m.id === active);
  const list = known
    ? KNOWN_MODELS
    : active
      ? [{ id: active, name: active, provider: "Configured" }, ...KNOWN_MODELS]
      : KNOWN_MODELS;
  return list.map((m) => ({ ...m, available: m.id === active }));
}

/**
 * What the picker offers.
 *
 * `apps/be` talks to one OpenAI-compatible endpoint and answers with the model it is actually
 * configured for. That one is selectable. Everything else here is listed and **disabled**: it
 * says what could be wired, and says plainly that it is not — which is the opposite of claiming
 * it works.
 *
 * It is also limited to providers whose mark the template already ships, because a row with a
 * generic star says nothing about who would be answering and an invented logo would be worse.
 * Adding a provider here means adding its logo in `provider-logo.tsx` at the same time.
 */
export type KnownModel = {
  id: string;
  name: string;
  provider: string;
};

export const KNOWN_MODELS: KnownModel[] = [
  { id: "gpt-4o-mini", name: "GPT-4o mini", provider: "OpenAI" },
  { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "Anthropic" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google" },
  { id: "deepseek-chat", name: "DeepSeek V3", provider: "DeepSeek" },
  { id: "grok-4", name: "Grok 4", provider: "xAI" },
  { id: "qwen2.5-72b-instruct", name: "Qwen2.5 72B", provider: "Alibaba" },
  { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", provider: "Meta" },
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

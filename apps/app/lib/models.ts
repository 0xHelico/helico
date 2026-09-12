/**
 * What the picker offers.
 *
 * `apps/be` answers with every model it is actually configured for, in the order it asks them.
 * Those are selectable. Everything else here is listed and **disabled**: it says what could be
 * wired, and says plainly that it is not — which is the opposite of claiming it works.
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
  { id: "gemini-pro-agent", name: "Gemini Pro", provider: "Google" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google" },
  { id: "deepseek-chat", name: "DeepSeek V3", provider: "DeepSeek" },
  { id: "grok-4", name: "Grok 4", provider: "xAI" },
  { id: "qwen2.5-72b-instruct", name: "Qwen2.5 72B", provider: "Alibaba" },
  { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", provider: "Meta" },
];

/**
 * The list to render. Every model the backend serves is enabled; anything it does not serve is
 * listed and disabled.
 *
 * A served model this file has never heard of is still offered, under "Configured", with its own
 * id as its name. That is the case that matters when a router is pointed somewhere new: the menu
 * would otherwise hide the only model that works.
 */
export function modelChoices(served: string[]) {
  const unknown = served.filter((id) => !KNOWN_MODELS.some((m) => m.id === id));
  const list = [
    ...unknown.map((id) => ({ id, name: id, provider: "Configured" })),
    ...KNOWN_MODELS,
  ];
  return list.map((m) => ({ ...m, available: served.includes(m.id) }));
}

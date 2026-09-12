"use client";

import { useCallback, useState } from "react";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { Button } from "@/components/ui/button";
import type { SwapConfig } from "@/lib/api";
import { modelChoices } from "@/lib/models";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "./provider-logo";

/**
 * The template's model selector, and now an actual choice.
 *
 * `apps/be` reports every model it is configured for, in the order it asks them. Each of those is
 * selectable and picking one sends it with the next message; everything else is listed and
 * **disabled**, because a menu that let you pick a model nobody wired would be a menu of things
 * that silently do not work.
 *
 * A choice is a preference and not an override. The backend keeps the rest of the chain behind
 * whatever is picked, so choosing the slower model still falls back to the other one when its
 * router is down — and the step tree under the answer names the model that actually replied.
 */
export function ModelPicker({
  config,
  chosen,
  onChoose,
}: {
  config: SwapConfig;
  chosen: string | null;
  onChoose: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // `models` is what a current backend answers with. `model` alone is what an older one answers,
  // and a page newer than the service it talks to still has to show something true.
  const served = config.available
    ? (config.models ?? [config.model]).filter(Boolean)
    : [];
  const active =
    chosen && served.includes(chosen) ? chosen : (served[0] ?? null);
  const handleSelect = useCallback(
    (id: string) => {
      onChoose(id);
      setOpen(false);
    },
    [onChoose],
  );
  const choices = modelChoices(served);
  // Whose mark sits on the trigger. An endpoint configured for something this list does not know
  // has no provider and therefore no logo, which is honest: we do not know whose model it is.
  const activeProvider = choices.find((m) => m.id === active)?.provider ?? "";
  const byProvider = choices.reduce<Record<string, typeof choices>>(
    (acc, m) => {
      const group = acc[m.provider] ?? [];
      group.push(m);
      acc[m.provider] = group;
      return acc;
    },
    {},
  );

  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <ModelSelectorTrigger asChild>
        <Button
          className={cn(
            "h-7 max-w-[200px] justify-between gap-1.5 rounded-lg px-2 text-[12px] transition-colors",
            active
              ? "text-muted-foreground hover:text-foreground"
              : "text-destructive",
          )}
          data-testid="model-selector"
          variant="ghost"
        >
          <ProviderLogo provider={activeProvider} size={13} />
          <span className="truncate">
            {choices.find((m) => m.id === active)?.name ??
              active ??
              "no model configured"}
          </span>
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent commandDefaultValue={active ?? ""}>
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          {Object.entries(byProvider).map(([provider, models]) => (
            <ModelSelectorGroup heading={provider} key={provider}>
              {models.map((m) => (
                <ModelSelectorItem
                  className="justify-between gap-3"
                  disabled={!m.available}
                  key={m.id}
                  onSelect={handleSelect}
                  value={m.id}
                >
                  <span
                    className={cn(
                      "flex items-center gap-2",
                      !m.available && "opacity-50",
                    )}
                  >
                    <ProviderLogo provider={m.provider} />
                    {m.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {m.id === active
                      ? "in use"
                      : m.available
                        ? "available"
                        : "not configured"}
                  </span>
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

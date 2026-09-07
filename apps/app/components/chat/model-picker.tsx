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
 * The template's model selector, with one difference that matters: nothing here is a choice
 * yet. `apps/be` is configured for exactly one model and reports which; that one is enabled,
 * and every other entry is disabled and says why. A list that let you pick a model nobody wired
 * would be a menu of things that silently do not work.
 */
export function ModelPicker({ config }: { config: SwapConfig }) {
  const [open, setOpen] = useState(false);
  const active = config.available ? config.model : null;
  const handleSelect = useCallback(() => setOpen(false), []);
  const choices = modelChoices(active);
  // Whose mark sits on the trigger. An endpoint configured for something this list does not know
  // has no provider and therefore no logo, which is honest: we do not know whose model it is.
  const activeProvider = choices.find((m) => m.available)?.provider ?? "";
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
          <span className="truncate">{active ?? "no model configured"}</span>
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
                  // There is one model to pick and it is already in use, so choosing it only
                  // has to close the popover. Without this the row swallows the click and the
                  // menu stays open, which reads as broken rather than as settled.
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
                    {m.available ? "in use" : "not configured"}
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

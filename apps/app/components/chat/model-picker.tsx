"use client";

import { useState } from "react";
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
import { SparklesIcon } from "./icons";

/**
 * The template's model selector, with one difference that matters: nothing here is a choice
 * yet. `apps/be` is configured for exactly one model and reports which; that one is enabled,
 * and every other entry is disabled and says why. A list that let you pick a model nobody wired
 * would be a menu of things that silently do not work.
 */
export function ModelPicker({ config }: { config: SwapConfig | null }) {
  const [open, setOpen] = useState(false);
  const active = config?.available ? config.model : null;
  const choices = modelChoices(active);
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
          <SparklesIcon size={13} />
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
                  value={m.id}
                >
                  <span className={cn(!m.available && "opacity-50")}>
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

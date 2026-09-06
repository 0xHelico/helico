"use client";

import { isToday, isYesterday, subMonths, subWeeks } from "date-fns";
import { TrashIcon } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import useSWR from "swr";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { api, type Conversation } from "@/lib/api";

export const HISTORY_KEY = "conversations";

/** The template groups by age, which is what makes a long list readable. */
function group(conversations: Conversation[]) {
  const now = new Date();
  const week = subWeeks(now, 1);
  const month = subMonths(now, 1);
  const buckets: Record<string, Conversation[]> = {
    Today: [],
    Yesterday: [],
    "Last 7 days": [],
    "Last 30 days": [],
    Older: [],
  };
  for (const c of conversations) {
    const at = new Date(c.updatedAt);
    if (isToday(at)) {
      buckets.Today.push(c);
    } else if (isYesterday(at)) {
      buckets.Yesterday.push(c);
    } else if (at > week) {
      buckets["Last 7 days"].push(c);
    } else if (at > month) {
      buckets["Last 30 days"].push(c);
    } else {
      buckets.Older.push(c);
    }
  }
  return Object.entries(buckets).filter(([, items]) => items.length > 0);
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <div className="px-2 py-3 text-sidebar-foreground/50 text-xs leading-relaxed group-data-[collapsible=icon]:hidden">
          {children}
        </div>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function SidebarHistory({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const [deleting, setDeleting] = useState<string | null>(null);

  const { data, isLoading, mutate } = useSWR(
    signedIn ? HISTORY_KEY : null,
    () => api.conversations(),
    { revalidateOnFocus: false },
  );

  const remove = useCallback(
    async (id: string) => {
      setDeleting(id);
      try {
        await api.deleteConversation(id);
        await mutate((list) => (list ?? []).filter((c) => c.id !== id), {
          revalidate: false,
        });
        if (params?.id === id) {
          router.push("/");
        }
      } finally {
        setDeleting(null);
      }
    },
    [mutate, params?.id, router],
  );

  if (!signedIn) {
    // An empty list looks like a bug. Saying why does not.
    return (
      <Note>
        Sign in with your wallet to keep conversations. Asking and reading work
        without it.
      </Note>
    );
  }
  if (isLoading) {
    return (
      <SidebarGroup>
        <SidebarGroupContent className="flex flex-col gap-1 px-2 group-data-[collapsible=icon]:hidden">
          {[60, 42, 74].map((w) => (
            <div
              className="h-6 animate-pulse rounded-md bg-sidebar-foreground/10"
              key={w}
              style={{ width: `${w}%` }}
            />
          ))}
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }
  if (!data || data.length === 0) {
    return <Note>Your conversations will appear here.</Note>;
  }

  return (
    <>
      {group(data).map(([label, items]) => (
        <SidebarGroup key={label}>
          <SidebarGroupLabel className="text-sidebar-foreground/40 text-xs">
            {label}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((c) => (
                <SidebarMenuItem key={c.id}>
                  <SidebarMenuButton
                    asChild
                    className="rounded-lg text-[13px] text-sidebar-foreground/80"
                    isActive={params?.id === c.id}
                  >
                    <Link href={`/chat/${c.id}`}>
                      <span className="truncate">{c.title}</span>
                    </Link>
                  </SidebarMenuButton>
                  <SidebarMenuAction
                    aria-label={`Delete ${c.title}`}
                    className="text-sidebar-foreground/40 hover:text-destructive"
                    disabled={deleting === c.id}
                    onClick={() => remove(c.id)}
                    showOnHover
                  >
                    <TrashIcon className="size-3.5" />
                  </SidebarMenuAction>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

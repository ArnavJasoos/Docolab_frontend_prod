"use client";

import * as React from "react";

import type { PresenceHue, PresenceUser } from "@/lib/types";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { usePresence } from "@/lib/hooks/use-presence";

const HUE_RING: Record<PresenceHue, string> = {
  violet: "ring-presence-violet",
  fuchsia: "ring-presence-fuchsia",
  orange: "ring-presence-orange",
  teal: "ring-presence-teal",
  rose: "ring-presence-rose",
  lime: "ring-presence-lime",
  sky: "ring-presence-sky",
  amber: "ring-presence-amber",
};

const HUE_BG: Record<PresenceHue, string> = {
  violet: "bg-presence-violet",
  fuchsia: "bg-presence-fuchsia",
  orange: "bg-presence-orange",
  teal: "bg-presence-teal",
  rose: "bg-presence-rose",
  lime: "bg-presence-lime",
  sky: "bg-presence-sky",
  amber: "bg-presence-amber",
};

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function PresenceAvatar({ user }: { user: PresenceUser }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar
          size="sm"
          className={cn(
            "ring-2 ring-offset-1 ring-offset-surface",
            HUE_RING[user.hue],
            user.state === "idle" && "opacity-60",
          )}
        >
          {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt={user.name} />}
          <AvatarFallback className={cn("text-white", HUE_BG[user.hue])}>
            {initials(user.name)}
          </AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent>
        {user.name}
        {user.id === "you" && " (you)"}
        <span className="text-background/60">
          {" · "}
          {user.state === "active" ? "Active now" : "Idle"}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export function PresenceStack({
  docId,
  max = 4,
  onOpenShare,
}: {
  docId: string;
  max?: number;
  onOpenShare?: () => void;
}) {
  const users = usePresence(docId);
  if (!users.length) return null;

  const shown = users.slice(0, max);
  const overflow = users.length - shown.length;
  const activeCount = users.filter((u) => u.state === "active").length;

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${users.length} people in this document`}
        className="flex items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary-container"
      >
        <AvatarGroup data-size="sm">
          {shown.map((u) => (
            <PresenceAvatar key={u.id} user={u} />
          ))}
          {overflow > 0 && (
            <AvatarGroupCount className="size-6 text-ui-xs font-semibold">
              +{overflow}
            </AvatarGroupCount>
          )}
        </AvatarGroup>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="flex items-center justify-between px-3 py-2.5">
          <p className="font-ui-sm text-ui-sm font-semibold text-text-primary">
            In this document
          </p>
          <span className="rounded-full bg-insertion-bg px-2 py-0.5 font-ui-xs text-ui-xs font-semibold text-insertion-text">
            {activeCount} active
          </span>
        </div>
        <div className="max-h-64 overflow-y-auto border-t border-border-subtle py-1">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-2.5 px-3 py-1.5">
              <span className="relative">
                <Avatar size="sm" className={cn(HUE_RING[u.hue], "ring-2 ring-offset-1 ring-offset-surface")}>
                  {u.avatarUrl && <AvatarImage src={u.avatarUrl} alt={u.name} />}
                  <AvatarFallback className={cn("text-white", HUE_BG[u.hue])}>
                    {initials(u.name)}
                  </AvatarFallback>
                </Avatar>
                <span
                  className={cn(
                    "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface",
                    u.state === "active" ? "bg-insertion-text" : "bg-text-muted",
                  )}
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-ui-sm text-ui-sm font-medium text-text-primary">
                  {u.name}
                  {u.id === "you" && " (you)"}
                </p>
                <p className="font-ui-xs text-ui-xs text-text-muted">
                  {u.state === "active" ? "Editing now" : "Idle"}
                </p>
              </div>
            </div>
          ))}
        </div>
        {onOpenShare && (
          <button
            onClick={onOpenShare}
            className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-2.5 font-ui-sm text-ui-sm font-medium text-primary-container hover:bg-surface-container"
          >
            <Icon name="group_add" size={16} />
            Manage access
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

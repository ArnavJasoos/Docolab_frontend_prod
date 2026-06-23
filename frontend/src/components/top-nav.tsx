"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { User } from "@/lib/types";
import { Icon } from "@/components/icon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import * as auth from "@/lib/api/auth";
import * as notifications from "@/lib/api/notifications";

const initials = (name: string) =>
  name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";

export function TopNav({
  search,
  onSearchChange,
}: {
  search?: string;
  onSearchChange?: (value: string) => void;
}) {
  const router = useRouter();
  // Seed from the cached session for an instant render, then confirm with /auth/me.
  const [user, setUser] = React.useState<User | null>(() => auth.getCurrentUser());

  React.useEffect(() => {
    void auth.fetchCurrentUser().then((u) => {
      if (u) setUser(u);
    });
  }, []);

  const signOut = async () => {
    await auth.signOut();
    toast.success("Signed out");
    router.push("/");
  };

  const checkNotifications = async () => {
    try {
      const items = await notifications.listNotifications(); // unread-only by default
      const unread = items.length;
      toast.info(
        unread > 0
          ? `You have ${unread} unread notification${unread === 1 ? "" : "s"}`
          : "You're all caught up — no new notifications",
      );
    } catch {
      toast.error("Couldn't load notifications");
    }
  };

  return (
    <header className="z-50 flex h-14 w-full shrink-0 items-center justify-between border-b border-border-subtle bg-surface px-lg py-sm text-primary">
      <div className="flex items-center gap-xl">
        <Link
          href="/browser"
          className="flex items-center gap-2 font-display-sm text-display-sm font-bold text-primary"
        >
          <Icon name="description" fill className="text-[26px]" />
          Docflow
        </Link>
      </div>

      <div className="flex items-center gap-md">
        <div className="relative hidden items-center sm:flex">
          <Icon name="search" className="absolute left-2 text-lg text-text-muted" />
          <input
            value={search ?? ""}
            onChange={(e) => onSearchChange?.(e.target.value)}
            className="w-64 rounded-lg border border-border-subtle bg-surface-container-low py-1.5 pr-3 pl-8 font-ui-sm text-ui-sm text-text-primary transition-colors focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
            placeholder="Search documents…"
            type="text"
          />
        </div>

        <button
          onClick={() => void checkNotifications()}
          aria-label="Notifications"
          className="flex size-8 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container"
        >
          <Icon name="notifications" />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Account menu"
            className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary-container"
          >
            <Avatar size="sm" className="border border-border-subtle">
              {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt={user.name} />}
              <AvatarFallback>{user ? initials(user.name) : "?"}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuLabel className="flex flex-col">
              <span className="font-ui-sm text-ui-sm font-semibold text-text-primary">
                {user?.name ?? "Account"}
              </span>
              <span className="font-ui-xs text-ui-xs font-normal text-text-muted">
                {user?.email ?? ""}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => router.push("/browser?filter=starred")}>
              <Icon name="star" size={18} className="text-text-muted" /> Starred
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => toast.info("Settings — coming soon")}>
              <Icon name="settings" size={18} className="text-text-muted" /> Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void signOut()}>
              <Icon name="logout" size={18} /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

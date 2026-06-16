"use client";

import * as React from "react";
import { toast } from "sonner";

import type { Role, ShareState } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import * as collaborators from "@/lib/api/collaborators";

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  editor: "Editor",
  commenter: "Commenter",
  viewer: "Viewer",
};

const ASSIGNABLE: Role[] = ["editor", "commenter", "viewer"];

function RoleSelect({
  value,
  onChange,
  onRemove,
  disabled,
}: {
  value: Role;
  onChange: (r: Role) => void;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <span className="px-2 font-ui-sm text-ui-sm text-text-muted">
        {ROLE_LABEL[value]}
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1 rounded-md px-2 py-1 font-ui-sm text-ui-sm text-text-secondary outline-none hover:bg-surface-container focus-visible:ring-2 focus-visible:ring-primary-container">
        {ROLE_LABEL[value]}
        <Icon name="expand_more" size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {ASSIGNABLE.map((r) => (
          <DropdownMenuItem key={r} onSelect={() => onChange(r)}>
            <span className="flex-1">{ROLE_LABEL[r]}</span>
            {r === value && <Icon name="check" size={16} />}
          </DropdownMenuItem>
        ))}
        {onRemove && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              Remove access
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function initials(name: string) {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

export function ShareDialog({
  docId,
  docTitle,
  open,
  onOpenChange,
}: {
  docId: string;
  docTitle: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [state, setState] = React.useState<ShareState | null>(null);
  const [email, setEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<Role>("editor");
  const [inviting, setInviting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void collaborators.getShareState(docId).then((s) => {
      if (!cancelled) setState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [open, docId]);

  const invite = async () => {
    const value = email.trim();
    if (!value || !value.includes("@")) {
      toast.error("Enter a valid email address.");
      return;
    }
    setInviting(true);
    try {
      const next = await collaborators.inviteCollaborator(docId, value, inviteRole);
      setState(next);
      setEmail("");
      toast.success(`Invited ${value}`);
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (userId: string, role: Role) => {
    setState(await collaborators.updateCollaboratorRole(docId, userId, role));
  };

  const remove = async (userId: string) => {
    setState(await collaborators.removeCollaborator(docId, userId));
  };

  const setAccess = async (anyone: boolean) => {
    if (!state) return;
    setState(
      await collaborators.setGeneralAccess(
        docId,
        anyone ? "anyone" : "restricted",
        state.linkRole,
      ),
    );
  };

  const setLinkRole = async (role: Role) => {
    setState(await collaborators.setGeneralAccess(docId, "anyone", role));
  };

  const copyLink = async () => {
    if (!state) return;
    try {
      await navigator.clipboard.writeText(state.link);
      toast.success("Link copied to clipboard");
    } catch {
      toast.error("Couldn't copy link");
    }
  };

  const anyone = state?.generalAccess === "anyone";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="font-ui-lg text-ui-lg">
            Share “{docTitle}”
          </DialogTitle>
        </DialogHeader>

        {/* Invite row */}
        <div className="flex gap-2 px-6">
          <div className="flex flex-1 items-center rounded-lg border border-border-subtle bg-surface-bright px-3 focus-within:border-primary-container focus-within:ring-1 focus-within:ring-primary-container">
            <Icon name="person_add" size={18} className="text-text-muted" />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void invite()}
              placeholder="Add people by email"
              type="email"
              className="ml-2 flex-1 bg-transparent py-2 font-ui-sm text-ui-sm text-text-primary outline-none placeholder:text-text-muted"
            />
            <RoleSelect value={inviteRole} onChange={setInviteRole} />
          </div>
          <button
            onClick={() => void invite()}
            disabled={inviting}
            className="rounded-lg bg-primary-container px-4 font-ui-sm text-ui-sm font-semibold text-on-primary transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {inviting ? "Inviting…" : "Invite"}
          </button>
        </div>

        {/* People list */}
        <div className="mt-4 max-h-64 overflow-y-auto px-3">
          <p className="px-3 pb-1 font-ui-xs text-ui-xs text-text-muted">
            People with access
          </p>
          {!state && (
            <div className="space-y-2 p-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-9 animate-pulse rounded bg-surface-container" />
              ))}
            </div>
          )}
          {state?.collaborators.map(({ user, role }) => (
            <div
              key={user.id}
              className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-surface-container-low"
            >
              <Avatar size="sm">
                {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt={user.name} />}
                <AvatarFallback>{initials(user.name)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate font-ui-sm text-ui-sm font-medium text-text-primary">
                  {user.name}
                  {user.id === "you" && " (you)"}
                </p>
                <p className="truncate font-ui-xs text-ui-xs text-text-muted">
                  {user.email}
                </p>
              </div>
              <RoleSelect
                value={role}
                disabled={role === "owner"}
                onChange={(r) => void changeRole(user.id, r)}
                onRemove={() => void remove(user.id)}
              />
            </div>
          ))}
        </div>

        {/* General access */}
        <div className="mt-2 border-t border-border-subtle px-6 py-4">
          <p className="pb-2 font-ui-xs text-ui-xs text-text-muted">General access</p>
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-full",
                anyone ? "bg-insertion-bg text-insertion-text" : "bg-surface-container text-text-secondary",
              )}
            >
              <Icon name={anyone ? "public" : "lock"} size={20} />
            </div>
            <div className="flex-1">
              <DropdownMenu>
                <DropdownMenuTrigger className="flex items-center gap-1 rounded-md font-ui-sm text-ui-sm font-medium text-text-primary outline-none hover:underline">
                  {anyone ? "Anyone with the link" : "Restricted"}
                  <Icon name="expand_more" size={16} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => void setAccess(false)}>
                    <span className="flex-1">Restricted</span>
                    {!anyone && <Icon name="check" size={16} />}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void setAccess(true)}>
                    <span className="flex-1">Anyone with the link</span>
                    {anyone && <Icon name="check" size={16} />}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <p className="font-ui-xs text-ui-xs text-text-muted">
                {anyone
                  ? `Anyone on the internet with the link can ${state?.linkRole}.`
                  : "Only people with access can open this link."}
              </p>
            </div>
            {anyone && state && (
              <RoleSelect value={state.linkRole} onChange={(r) => void setLinkRole(r)} />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border-subtle px-6 py-4">
          <button
            onClick={() => void copyLink()}
            className="flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 font-ui-sm text-ui-sm font-medium text-text-secondary transition-colors hover:bg-surface-container"
          >
            <Icon name="link" size={18} />
            Copy link
          </button>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded-lg bg-primary-container px-5 py-2 font-ui-sm text-ui-sm font-semibold text-on-primary transition-colors hover:bg-accent-hover"
          >
            Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

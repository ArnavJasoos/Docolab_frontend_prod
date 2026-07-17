"use client";

import * as React from "react";
import { toast } from "sonner";

import { Icon } from "@/components/icon";
import { InitialsAvatar } from "@/components/admin/avatar";
import { useAdmin } from "@/components/admin/admin-guard";
import { ApiError } from "@/lib/api/client";
import { createUser, createAdmin, type AdminUser } from "@/lib/api/admin";

function relativeTime(iso?: string | null): string {
  if (!iso) return "";
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// Requirements 4, 5, 12: every org member with online/offline status and email.
// Clicking a user opens their profile modal (requirement 13).
export function UsersPanel({
  users,
  loading,
  search,
  onSelectUser,
  onUserCreated,
}: {
  users: AdminUser[];
  loading: boolean;
  search: string;
  onSelectUser: (u: AdminUser) => void;
  onUserCreated: () => void;
}) {
  const admin = useAdmin();
  const [addOpen, setAddOpen] = React.useState(false);
  const [addAdminOpen, setAddAdminOpen] = React.useState(false);
  const q = search.trim().toLowerCase();
  const filtered = q
    ? users.filter((u) => u.display_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    : users;
  const onlineCount = users.filter((u) => u.online).length;

  return (
    <div className="gl-card flex flex-1 flex-col overflow-hidden">
      <div className="gl-card-header space-y-3 px-6 py-4">
        <h3 className="flex items-center gap-2 font-medium text-[var(--gl-on-surface)]">
          <Icon name="groups" className="text-base text-[rgba(125,211,252,0.8)]" />
          Users
          <span className="rounded-full bg-[rgba(74,222,128,0.12)] px-2 py-0.5 text-[10px] font-medium text-[#4ade80]">
            {onlineCount} online
          </span>
        </h3>
        <div className="flex items-center gap-3">
          {admin.is_super_admin && (
            <button
              onClick={() => setAddAdminOpen(true)}
              className="gl-btn flex-1 px-3 py-2 text-xs font-medium"
              title="Create another admin account"
            >
              <Icon name="shield_person" className="text-[16px]" /> Add Admin
            </button>
          )}
          <button onClick={() => setAddOpen(true)} className="gl-btn flex-1 px-3 py-2 text-xs font-medium">
            <Icon name="person_add" className="text-[16px]" /> Add User
          </button>
        </div>
      </div>

      {addOpen && (
        <AddUserDialog
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false);
            onUserCreated();
          }}
        />
      )}

      {addAdminOpen && (
        <AddAdminDialog
          onClose={() => setAddAdminOpen(false)}
          onCreated={() => {
            setAddAdminOpen(false);
            onUserCreated();
          }}
        />
      )}

      <div className="flex-1 space-y-1 overflow-y-auto p-2" style={{ maxHeight: 340 }}>
        {loading ? (
          <div className="flex justify-center py-8">
            <Icon name="progress_activity" className="gl-spin text-xl text-[var(--gl-primary)]" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-xs text-[var(--gl-on-surface-variant)]">No users found.</p>
        ) : (
          filtered.map((u) => (
            <button
              key={u.id}
              onClick={() => onSelectUser(u)}
              className="gl-row group flex w-full items-center gap-4 rounded-lg p-3 text-left"
            >
              <InitialsAvatar name={u.display_name} color={u.avatar_color} size={40} online={u.online} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[var(--gl-on-surface)] group-hover:text-[var(--gl-primary)]">
                  {u.display_name}
                  {u.is_admin && (
                    <span className="ml-2 rounded bg-[rgba(125,211,252,0.12)] px-1.5 py-0.5 text-[10px] text-[var(--gl-primary)]">
                      {u.is_super_admin ? "Primary admin" : "Admin"}
                    </span>
                  )}
                  {u.status === "disabled" && (
                    <span className="ml-2 text-[10px] text-[var(--gl-error)]">delisted</span>
                  )}
                </p>
                <p className="truncate text-xs text-[var(--gl-on-surface-variant)]">{u.email}</p>
              </div>
              {u.online ? (
                <Icon
                  name="chevron_right"
                  className="text-base text-[var(--gl-on-surface-variant)] opacity-0 transition-opacity group-hover:opacity-100"
                />
              ) : (
                <span className="shrink-0 text-xs text-[var(--gl-on-surface-variant)]">{relativeTime(u.last_seen_at)}</span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// Requirement 4 (add side): create a new org member. On success the new user
// appears in the directory and can be assigned to documents.
function AddUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Enter a display name.");
    if (!email.includes("@")) return setError("Enter a valid email.");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    setBusy(true);
    try {
      const u = await createUser({ email, display_name: name, password });
      toast.success(`Created ${u.display_name}`);
      onCreated();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 409
            ? "That email is already registered."
            : err.message
          : "Failed to create user.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gl-overlay" onMouseDown={onClose}>
      <form
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        className="gl-card w-full max-w-[420px] space-y-4 p-6"
      >
        <div className="flex items-center gap-2">
          <Icon name="person_add" className="text-xl text-[var(--gl-primary)]" />
          <h3 className="text-lg font-semibold text-[var(--gl-on-surface)]">Add User</h3>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-[rgba(255,107,107,0.3)] bg-[rgba(255,107,107,0.08)] px-3 py-2 text-xs text-[var(--gl-error)]">
            <Icon name="error" size={16} />
            {error}
          </div>
        )}

        <div className="space-y-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="gl-input rounded-lg px-3 py-2.5 text-sm"
          />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="off"
            className="gl-input rounded-lg px-3 py-2.5 text-sm"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Temporary password (min 8 chars)"
            autoComplete="new-password"
            className="gl-input rounded-lg px-3 py-2.5 text-sm"
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-1">
          <button type="button" onClick={onClose} className="gl-btn gl-btn-ghost px-4 py-2 text-sm">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="gl-btn gl-btn-solid px-5 py-2 text-sm font-semibold">
            {busy ? <Icon name="progress_activity" className="gl-spin text-base" /> : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Requirement 4: the primary admin creates another admin account with dashboard
// access. Same fields as Add User; the backend grants the org-scoped admin role.
function AddAdminDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Enter a display name.");
    if (!email.includes("@")) return setError("Enter a valid email.");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    setBusy(true);
    try {
      const u = await createAdmin({ email, display_name: name, password });
      toast.success(`Created admin ${u.display_name}`);
      onCreated();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 409
            ? "That email is already registered."
            : err.status === 403
              ? "Only the primary admin can create admin accounts."
              : err.message
          : "Failed to create admin.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gl-overlay" onMouseDown={onClose}>
      <form
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        className="gl-card w-full max-w-[420px] space-y-4 p-6"
      >
        <div className="flex items-center gap-2">
          <Icon name="shield_person" className="text-xl text-[var(--gl-primary)]" />
          <h3 className="text-lg font-semibold text-[var(--gl-on-surface)]">Add Admin Account</h3>
        </div>

        <p className="text-xs text-[var(--gl-on-surface-variant)]">
          This account will have full admin-dashboard access. It cannot create other admins or
          delist the primary admin.
        </p>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-[rgba(255,107,107,0.3)] bg-[rgba(255,107,107,0.08)] px-3 py-2 text-xs text-[var(--gl-error)]">
            <Icon name="error" size={16} />
            {error}
          </div>
        )}

        <div className="space-y-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="gl-input rounded-lg px-3 py-2.5 text-sm"
          />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="off"
            className="gl-input rounded-lg px-3 py-2.5 text-sm"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password (min 8 chars)"
            autoComplete="new-password"
            className="gl-input rounded-lg px-3 py-2.5 text-sm"
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-1">
          <button type="button" onClick={onClose} className="gl-btn gl-btn-ghost px-4 py-2 text-sm">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="gl-btn gl-btn-solid px-5 py-2 text-sm font-semibold">
            {busy ? <Icon name="progress_activity" className="gl-spin text-base" /> : "Create Admin"}
          </button>
        </div>
      </form>
    </div>
  );
}

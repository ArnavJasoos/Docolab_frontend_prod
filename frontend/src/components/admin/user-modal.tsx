"use client";

import * as React from "react";
import { toast } from "sonner";

import { Icon } from "@/components/icon";
import { InitialsAvatar } from "@/components/admin/avatar";
import { useAdmin } from "@/components/admin/admin-guard";
import { ApiError } from "@/lib/api/client";
import {
  userDocuments,
  assignDocumentToUser,
  upsertDocAccess,
  removeDocAccess,
  setMembership,
  setUserAiModel,
  listAiModels,
  ROLE_OPTIONS,
  ROLE_LABELS,
  DEFAULT_ROLE,
  type AdminUser,
  type AdminDoc,
  type AiModelItem,
  type BackendRole,
} from "@/lib/api/admin";

// Requirements 4, 10, 13: inspect one user — see the documents they can access,
// assign a document to them with a role (default Collaborator), remove access,
// and list/delist their org membership.
export function UserModal({
  user,
  allDocs,
  onClose,
  onChanged,
}: {
  user: AdminUser;
  allDocs: AdminDoc[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const admin = useAdmin();
  const [docs, setDocs] = React.useState<AdminDoc[] | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [addQuery, setAddQuery] = React.useState("");
  const [addRole, setAddRole] = React.useState<BackendRole>(DEFAULT_ROLE);
  const [busy, setBusy] = React.useState(false);
  const [models, setModels] = React.useState<AiModelItem[]>([]);
  const [model, setModel] = React.useState(user.ai_model);
  const [modelSaving, setModelSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setDocs(await userDocuments(user.id));
  }, [user.id]);

  React.useEffect(() => {
    load().catch((e) => toast.error(e instanceof ApiError ? e.message : "Failed to load"));
    listAiModels()
      .then(setModels)
      .catch(() => {
        /* catalog is optional chrome; the current value still renders */
      });
  }, [load]);

  // Requirement 1: assign this user's AI model. Save immediately on change,
  // rolling back the dropdown if the backend rejects it.
  const changeModel = async (next: string) => {
    const prev = model;
    setModel(next);
    setModelSaving(true);
    try {
      const updated = await setUserAiModel(user.id, next);
      setModel(updated.ai_model);
      onChanged();
      toast.success("AI model updated");
    } catch (e) {
      setModel(prev);
      toast.error(e instanceof ApiError ? e.message : "Failed to set AI model");
    } finally {
      setModelSaving(false);
    }
  };

  const assignedIds = new Set((docs ?? []).map((d) => d.id));
  const addable = allDocs.filter(
    (d) => !assignedIds.has(d.id) && d.title.toLowerCase().includes(addQuery.toLowerCase()),
  );

  const addDoc = async (d: AdminDoc) => {
    try {
      await assignDocumentToUser(user.id, d.id, addRole);
      setAddOpen(false);
      setAddQuery("");
      await load();
      onChanged();
      toast.success(`Assigned "${d.title}" as ${ROLE_LABELS[addRole]}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to assign");
    }
  };

  const removeDoc = async (d: AdminDoc) => {
    try {
      await removeDocAccess(d.id, user.id);
      setDocs((prev) => prev?.filter((x) => x.id !== d.id) ?? prev);
      onChanged();
      toast.success(`Removed access to "${d.title}"`);
    } catch (e) {
      // 404 = the user is the creator (no explicit assignment to drop).
      toast.error(
        e instanceof ApiError && e.status === 404
          ? "User is the creator — access can't be removed here."
          : e instanceof ApiError
            ? e.message
            : "Failed to remove",
      );
    }
  };

  // Change this user's role on one document. Optimistic — roll back on failure.
  const changeRole = async (d: AdminDoc, role: BackendRole) => {
    const prev = d.role_name ?? null;
    setDocs((cur) => cur?.map((x) => (x.id === d.id ? { ...x, role_name: role } : x)) ?? cur);
    try {
      await upsertDocAccess(d.id, user.id, role);
      onChanged();
      toast.success(`${user.display_name} is now ${ROLE_LABELS[role]} on "${d.title}"`);
    } catch (e) {
      setDocs((cur) => cur?.map((x) => (x.id === d.id ? { ...x, role_name: prev } : x)) ?? cur);
      toast.error(e instanceof ApiError ? e.message : "Failed to change role");
    }
  };

  const disabled = user.status === "disabled";

  // Mirrors the delisting guards in PATCH /admin/users/{id}/membership: nobody
  // delists themselves or the primary admin, and only the primary admin may
  // delist a fellow admin. Reactivating stays open to any admin.
  const delistBlockReason =
    user.id === admin.id
      ? "You cannot delist your own account"
      : user.is_super_admin
        ? "The primary administrator account cannot be delisted"
        : user.is_admin && !admin.is_super_admin
          ? "Only the primary administrator can delist an admin account"
          : null;

  const toggleMembership = async () => {
    const activating = user.status === "disabled";
    if (!activating && delistBlockReason) return;
    if (!activating && !confirm(`Delist ${user.display_name}? They will no longer be able to sign in.`)) return;
    setBusy(true);
    try {
      await setMembership(user.id, activating);
      toast.success(activating ? "User reactivated" : "User delisted");
      onChanged();
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed to update membership");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gl-overlay" onMouseDown={onClose}>
      <div
        className="gl-card relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[rgba(125,211,252,0.1)] p-6">
          <div className="flex min-w-0 items-center gap-3">
            <InitialsAvatar name={user.display_name} color={user.avatar_color} size={52} online={user.online} />
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 truncate text-lg font-semibold text-[var(--gl-on-surface)]">
                {user.display_name}
                {disabled && (
                  <span className="rounded bg-[rgba(255,107,107,0.12)] px-1.5 py-0.5 text-[10px] text-[var(--gl-error)]">
                    Delisted
                  </span>
                )}
              </h2>
              <p className="truncate text-xs text-[var(--gl-on-surface-variant)]">{user.email}</p>
              <p className="mt-0.5 text-[11px] text-[var(--gl-on-surface-variant)]">
                {user.online ? "● Online now" : user.last_seen_at ? `Last seen ${new Date(user.last_seen_at).toLocaleString()}` : "Offline"}
              </p>
            </div>
          </div>
          <div className="relative flex shrink-0 items-center gap-2">
            <button onClick={() => setAddOpen((v) => !v)} className="gl-btn gl-btn-solid px-3 py-1.5 text-xs font-medium">
              <Icon name="add" className="text-[16px]" /> Add Document
            </button>
            <button
              onClick={toggleMembership}
              disabled={busy || (!disabled && delistBlockReason !== null)}
              title={!disabled && delistBlockReason ? delistBlockReason : undefined}
              className={`gl-btn px-3 py-1.5 text-xs font-medium ${disabled ? "gl-btn-solid" : "gl-btn-danger"}`}
            >
              <Icon name={disabled ? "person_check" : "person_remove"} className="text-[16px]" />
              {disabled ? "Reactivate" : "Delist User"}
            </button>
            {addOpen && (
              <div className="gl-card absolute right-0 top-11 z-20 w-80 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <div className="relative flex-1">
                    <Icon
                      name="search"
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-[var(--gl-on-surface-variant)]"
                    />
                    <input
                      autoFocus
                      value={addQuery}
                      onChange={(e) => setAddQuery(e.target.value)}
                      placeholder="Search documents…"
                      className="gl-input w-full rounded-lg py-2 pl-9 pr-3 text-sm"
                    />
                  </div>
                  <select
                    value={addRole}
                    onChange={(e) => setAddRole(e.target.value as BackendRole)}
                    className="gl-select w-28 rounded-lg px-2 py-2 text-xs"
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="max-h-52 overflow-y-auto">
                  {addable.length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-[var(--gl-on-surface-variant)]">No documents</p>
                  ) : (
                    addable.slice(0, 20).map((d) => (
                      <button
                        key={d.id}
                        onClick={() => addDoc(d)}
                        className="gl-row flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left"
                      >
                        <Icon name="description" className="text-lg text-[var(--gl-primary)]" />
                        <span className="truncate text-sm text-[var(--gl-on-surface)]">{d.title}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Body: AI model + assigned documents */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Requirement 1: per-user AI model (moved here from the Document modal). */}
          <div className="mb-6">
            <label className="mb-1.5 flex items-center gap-2 text-sm font-medium text-[var(--gl-on-surface-variant)]">
              AI Model
              {modelSaving && <Icon name="progress_activity" className="gl-spin text-sm text-[var(--gl-primary)]" />}
            </label>
            <select
              value={model}
              disabled={modelSaving}
              onChange={(e) => changeModel(e.target.value)}
              className="gl-select rounded-lg px-3 py-2.5 text-sm disabled:opacity-60"
            >
              {/* Keep the current value visible even if it left the catalog. */}
              {!models.some((m) => m.model_key === model) && <option value={model}>{model}</option>}
              {models
                .filter((m) => m.enabled)
                .map((m) => (
                  <option key={m.id} value={m.model_key}>
                    {m.display_name} {m.is_default ? "(default)" : ""}
                  </option>
                ))}
            </select>
            <p className="mt-1 text-[11px] text-[var(--gl-on-surface-variant)]">
              Used by this user&apos;s editor for AI actions.
            </p>
          </div>

          <p className="mb-2 text-sm font-medium text-[var(--gl-on-surface-variant)]">Assigned Documents</p>
          {docs === null ? (
            <div className="flex justify-center py-6">
              <Icon name="progress_activity" className="gl-spin text-xl text-[var(--gl-primary)]" />
            </div>
          ) : docs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[rgba(125,211,252,0.1)] px-3 py-6 text-center text-xs text-[var(--gl-on-surface-variant)]">
              This user has no documents yet.
            </p>
          ) : (
            <div className="space-y-2">
              {docs.map((d) => {
                const isCreator = d.created_by === user.id;
                return (
                  <div
                    key={d.id}
                    className="flex items-center gap-3 rounded-lg border border-[rgba(125,211,252,0.06)] bg-[rgba(26,36,56,0.3)] p-3"
                  >
                    <Icon name="description" className="text-xl text-[var(--gl-primary)]" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[var(--gl-on-surface)]">{d.title}</p>
                      <p className="text-xs text-[var(--gl-on-surface-variant)]">
                        {isCreator ? "Created by this user" : "Shared with this user"}
                      </p>
                    </div>
                    {/* Per-document role. Changeable for any user — including the
                        creator (writing a document-scoped assignment overrides the
                        creator-owns fallback). */}
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-xs text-[var(--gl-on-surface-variant)]">Role</span>
                      <select
                        value={d.role_name ?? (isCreator ? "owner" : "")}
                        onChange={(ev) => changeRole(d, ev.target.value as BackendRole)}
                        title={isCreator ? "Creator — change to override creator-owns" : "Change role"}
                        className="gl-select w-28 rounded-lg px-2 py-1.5 text-xs disabled:opacity-60"
                      >
                        {!d.role_name && !isCreator && <option value="">— none —</option>}
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      onClick={() => removeDoc(d)}
                      disabled={isCreator}
                      title={
                        isCreator
                          ? "Creator owns this document — remove by deleting or transferring it"
                          : "Remove access"
                      }
                      className="gl-btn gl-btn-ghost h-8 w-8 shrink-0 rounded-lg p-0 disabled:opacity-30"
                    >
                      <Icon name="delete" className="text-[18px]" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-[rgba(125,211,252,0.1)] p-6">
          <button onClick={onClose} className="gl-btn gl-btn-ghost px-4 py-2 text-sm">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

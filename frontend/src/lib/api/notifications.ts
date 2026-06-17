// =============================================================================
// lib/api/notifications.ts
// Frontend client for the Notifications cluster.
// Maps to backend api/notifications.py (mounted at /api/notifications).
//
// Backend routes:
//   GET  /notifications?unread=true
//   POST /notifications/:id/read
//   POST /notifications/read-all
// =============================================================================

import { apiFetch } from "./client";

export interface Notification {
  id: string;
  user_id: string;
  document_id: string;
  type: string;
  payload: Record<string, unknown>;
  delivered: boolean;
  created_at: string;
  read_at: string | null;
}

/** Fetch notifications. Pass unreadOnly=true for the catch-up popup. */
export async function listNotifications(unreadOnly = true): Promise<Notification[]> {
  const data = await apiFetch<{ notifications: Notification[] }>(
    `/notifications${unreadOnly ? "?unread=true" : ""}`,
  );
  return data.notifications;
}

/** Mark a single notification read. */
export async function markRead(id: string) {
  return apiFetch<{ success: boolean; message: string }>(
    `/notifications/${id}/read`,
    { method: "POST", body: "{}" },
  );
}

/** Mark all of the current user's notifications read. */
export async function markAllRead() {
  return apiFetch<{ success: boolean; message: string; count: number }>(
    `/notifications/read-all`,
    { method: "POST", body: "{}" },
  );
}

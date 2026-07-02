# =============================================================================
# app/services/audit_service.py
# Centralised audit-log writer + the canonical action vocabulary.
#
# WHY: the design requires every state-changing endpoint to record what
# happened, in the SAME transaction as the action (so an action can never be
# committed without its audit row, or vice-versa). `record_audit` only queues
# the row with db.add(); the endpoint's existing `await db.commit()` persists
# it alongside the change.
#
# audit_log is APPEND-ONLY — there is intentionally no update/delete path.
# =============================================================================

from app.models.database_models import AuditLog


class AuditAction:
    """Canonical `action` strings (kept consistent across all endpoints)."""
    # identity & membership
    USER_SIGNUP = "user_signup"
    USER_UPDATE = "user_update"
    ROLE_CHANGE = "role_change"            # assignment created
    ROLE_REVOKE = "role_revoke"            # assignment removed
    OWNERSHIP_TRANSFER = "ownership_transfer"
    # sessions (auth)
    LOGIN = "login"
    LOGOUT = "logout"
    TOKEN_REFRESH = "token_refresh"
    # content
    FOLDER_CREATE = "folder_create"
    FOLDER_UPDATE = "folder_update"
    FOLDER_DELETE = "folder_delete"
    DOCUMENT_CREATE = "document_create"
    DOCUMENT_UPDATE = "document_update"
    DOCUMENT_DELETE = "document_delete"    # permanent (status=deleted)
    DOCUMENT_TRASH = "document_trash"      # reversible recycle-bin move
    DOCUMENT_RESTORE = "document_restore"  # restore from recycle bin
    DOCUMENT_STAR = "document_star"        # personal bookmark add
    DOCUMENT_UNSTAR = "document_unstar"    # personal bookmark remove
    # collaboration (inner loop)
    SUGGESTION_CREATE = "suggestion_create"
    RESOLVE_SUGGESTION = "resolve_suggestion"
    REJECT_SUGGESTION = "reject_suggestion"
    COMMENT_CREATE = "comment_create"
    COMMENT_UPDATE = "comment_update"
    COMMENT_DELETE = "comment_delete"
    RECOMMENDATION_CREATE = "recommendation_create"
    RECOMMENDATION_UPDATE = "recommendation_update"
    RECOMMENDATION_RESPONSE = "recommendation_response"
    # governance (outer loop)
    SUBMIT = "submit"
    APPROVE = "approve"            # final approval (baseline advances)
    APPROVE_STEP = "approve_step"  # one step of a multi-step chain completed
    REJECT = "reject"
    RESTORE = "restore"
    AI_APPLY = "ai_apply"
    # approval policy administration
    POLICY_CREATE = "policy_create"
    POLICY_UPDATE = "policy_update"
    POLICY_ATTACH = "policy_attach"   # attach/detach a policy to a document


def record_audit(
    db,
    *,
    org_id,
    actor_id,
    action: str,
    target_type: str,
    target_id=None,
    document_id=None,
    meta: dict | None = None,
) -> None:
    """Queue one append-only audit_log row in the current transaction.

    Synchronous on purpose: db.add() does not hit the DB — the row is flushed
    by the endpoint's `await db.commit()`, keeping action + audit atomic.

    Args:
        org_id / actor_id: the tenant and the user performing the action.
        action: one of AuditAction.*  (the verb).
        target_type / target_id: the thing acted on (e.g. "document", <uuid>).
        document_id: the document this relates to (None for folder/user actions).
        meta: free-form JSON detail (changed fields, decision, reason, …).
    """
    db.add(AuditLog(
        org_id=org_id,
        actor_id=actor_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        document_id=document_id,
        meta=meta or {},
    ))

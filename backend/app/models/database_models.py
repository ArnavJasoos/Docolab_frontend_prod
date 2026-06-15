import uuid
from sqlalchemy import Column, String, ForeignKey, Integer, Boolean, Text, UniqueConstraint, DateTime, func
from sqlalchemy.orm import relationship
from app.core.database import Base

def generate_uuid():
    return str(uuid.uuid4())

class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=generate_uuid)
    org_id = Column(String, index=True, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    display_name = Column(String, nullable=False)
    avatar_color = Column(String, default="#7aa2f7")
    status = Column(String, default="active")

class Role(Base):
    __tablename__ = "roles"

    id = Column(String, primary_key=True, default=generate_uuid)
    name = Column(String, unique=True, index=True, nullable=False)

    permissions = relationship("RolePermission", back_populates="role", cascade="all, delete-orphan")

class RolePermission(Base):
    __tablename__ = "role_permissions"

    id = Column(String, primary_key=True, default=generate_uuid)
    role_id = Column(String, ForeignKey("roles.id", ondelete="CASCADE"), nullable=False)
    permission = Column(String, nullable=False)

    role = relationship("Role", back_populates="permissions")
    __table_args__ = (UniqueConstraint("role_id", "permission", name="_role_permission_uc"),)

class Folder(Base):
    __tablename__ = "folders"

    id = Column(String, primary_key=True, default=generate_uuid)
    org_id = Column(String, nullable=False)
    parent_folder_id = Column(String, ForeignKey("folders.id", ondelete="CASCADE"), nullable=True)
    name = Column(String, nullable=False)
    created_by = Column(String, ForeignKey("users.id"), nullable=False)

class Assignment(Base):
    __tablename__ = "assignments"

    id = Column(String, primary_key=True, default=generate_uuid)
    org_id = Column(String, nullable=False)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role_id = Column(String, ForeignKey("roles.id", ondelete="CASCADE"), nullable=False)
    scope_type = Column(String, nullable=False)
    scope_id = Column(String, nullable=False)

    __table_args__ = (UniqueConstraint("user_id", "scope_type", "scope_id", name="_user_scope_uc"),)

class Document(Base):
    __tablename__ = "documents"

    id = Column(String, primary_key=True, default=generate_uuid)
    org_id = Column(String, nullable=False)
    folder_id = Column(String, ForeignKey("folders.id", ondelete="CASCADE"), nullable=False)
    title = Column(String, nullable=False)
    yjs_doc_key = Column(String, nullable=False)
    schema_version = Column(Integer, default=1)
    status = Column(String, default="working")
    current_version_no = Column(Integer, default=0)
    offline_enabled = Column(Boolean, default=False)
    approval_policy_id = Column(String, nullable=True)
    created_by = Column(String, ForeignKey("users.id"), nullable=False)

class AuditLog(Base):
    __tablename__ = "audit_log"

    id = Column(String, primary_key=True, default=generate_uuid)
    action = Column(String, nullable=False)
    actor_id = Column(String, ForeignKey("users.id"), nullable=False)
    target_type = Column(String, nullable=False)
    target_id = Column(String, nullable=False)
    metadata_json = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
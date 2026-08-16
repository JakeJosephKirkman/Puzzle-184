import type { Mark, Op, RgaSnapshot } from '@/lib/crdt/types';

export type DocRole = 'owner' | 'editor' | 'viewer';

export type ActivityKind = 'edit' | 'comment' | 'join' | 'leave' | 'restore' | 'permission';

export interface Profile {
  id: string;
  display_name: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  title: string;
  owner_id: string;
  content: string;
  crdt_state: RgaSnapshot;
  snapshot_version: number;
  snapshot_seq: number;
  last_saved_at: string;
  created_at: string;
  updated_at: string;
}

export interface PermissionRow {
  id: string;
  document_id: string;
  user_id: string;
  role: DocRole;
  granted_by: string | null;
  created_at: string;
}

export interface OperationRow {
  seq: number;
  document_id: string;
  actor_id: string;
  site_id: string;
  lamport: number;
  op_id: string;
  op: Op | { mark: Mark };
  created_at: string;
}

export interface VersionRow {
  id: string;
  document_id: string;
  version_number: number;
  content: string;
  crdt_snapshot: RgaSnapshot;
  created_by: string | null;
  label: string | null;
  summary: VersionSummary;
  restored_from: string | null;
  created_at: string;
}

export interface VersionSummary {
  edits?: number;
  comments?: number;
  sections?: number;
  contributors?: string[];
}

export interface CommentAnchor {
  startId: string;
  endId: string;
  quotedText: string;
}

export interface CommentRow {
  id: string;
  document_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  anchor: CommentAnchor | null;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityRow {
  id: string;
  document_id: string;
  actor_id: string | null;
  kind: ActivityKind;
  payload: Record<string, unknown>;
  bucket: string | null;
  created_at: string;
  updated_at: string;
}

/** Ephemeral awareness state, carried by Realtime Presence rather than a table. */
export interface PresenceState {
  userId: string;
  sessionId: string;
  name: string;
  color: string;
  role: DocRole;
  cursor: { afterId: string | null } | null;
  selection: { startAfterId: string | null; endAfterId: string | null } | null;
  typing: boolean;
  typingNearLine: number | null;
  onlineAt: string;
}

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

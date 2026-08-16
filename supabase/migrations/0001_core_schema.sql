-- CollabSpace: core schema
-- Real-time collaborative workspace backed by an append-only CRDT operation log.
--
-- Design note: the durable source of truth for a document is `document_operations`,
-- not `documents.content`. The content column is a materialised convenience snapshot.
-- Replaying the op log always reproduces the document exactly, which is what makes
-- last-write-wins overwrites impossible.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.doc_role as enum ('owner', 'editor', 'viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.activity_kind as enum ('edit', 'comment', 'join', 'leave', 'restore', 'permission');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text        not null,
  color        text        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------

create table if not exists public.documents (
  id               uuid        primary key default gen_random_uuid(),
  title            text        not null default 'Untitled document',
  owner_id         uuid        not null references auth.users (id) on delete cascade,
  content          text        not null default '',
  crdt_state       jsonb       not null default '{"nodes":[],"marks":[]}'::jsonb,
  -- Optimistic concurrency guard. Bumped only via save_document_snapshot().
  snapshot_version bigint      not null default 0,
  last_saved_at    timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists documents_owner_idx on public.documents (owner_id);

-- ---------------------------------------------------------------------------
-- document_permissions
-- ---------------------------------------------------------------------------

create table if not exists public.document_permissions (
  id          uuid          primary key default gen_random_uuid(),
  document_id uuid          not null references public.documents (id) on delete cascade,
  user_id     uuid          not null references auth.users (id) on delete cascade,
  role        public.doc_role not null default 'viewer',
  granted_by  uuid          references auth.users (id) on delete set null,
  created_at  timestamptz   not null default now(),
  unique (document_id, user_id)
);

create index if not exists document_permissions_user_idx on public.document_permissions (user_id);

-- ---------------------------------------------------------------------------
-- document_operations  (append-only CRDT log -- the real source of truth)
-- ---------------------------------------------------------------------------

create table if not exists public.document_operations (
  seq         bigserial   primary key,
  document_id uuid        not null references public.documents (id) on delete cascade,
  actor_id    uuid        not null references auth.users (id) on delete cascade,
  site_id     text        not null,
  lamport     bigint      not null,
  op_id       text        not null,
  op          jsonb       not null,
  created_at  timestamptz not null default now(),
  -- Makes persistence idempotent at the database level: an outbox replaying the
  -- same operation after a reconnect cannot create a duplicate row.
  unique (document_id, op_id)
);

create index if not exists document_operations_doc_seq_idx
  on public.document_operations (document_id, seq);

-- ---------------------------------------------------------------------------
-- document_versions
-- ---------------------------------------------------------------------------

create table if not exists public.document_versions (
  id             uuid        primary key default gen_random_uuid(),
  document_id    uuid        not null references public.documents (id) on delete cascade,
  version_number integer     not null,
  content        text        not null,
  crdt_snapshot  jsonb       not null,
  created_by     uuid        references auth.users (id) on delete set null,
  label          text,
  summary        jsonb       not null default '{}'::jsonb,
  restored_from  uuid        references public.document_versions (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (document_id, version_number)
);

create index if not exists document_versions_doc_idx
  on public.document_versions (document_id, version_number desc);

-- ---------------------------------------------------------------------------
-- comments
-- ---------------------------------------------------------------------------

create table if not exists public.comments (
  id          uuid        primary key default gen_random_uuid(),
  document_id uuid        not null references public.documents (id) on delete cascade,
  parent_id   uuid        references public.comments (id) on delete cascade,
  author_id   uuid        not null references auth.users (id) on delete cascade,
  body        text        not null,
  -- { startId, endId, quotedText } -- CRDT character ids, not integer offsets,
  -- so the anchor tracks its text as the document is edited around it.
  anchor      jsonb,
  resolved    boolean     not null default false,
  resolved_by uuid        references auth.users (id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists comments_doc_idx on public.comments (document_id, created_at);
create index if not exists comments_parent_idx on public.comments (parent_id);

-- ---------------------------------------------------------------------------
-- activity_events
-- ---------------------------------------------------------------------------

create table if not exists public.activity_events (
  id          uuid                 primary key default gen_random_uuid(),
  document_id uuid                 not null references public.documents (id) on delete cascade,
  actor_id    uuid                 references auth.users (id) on delete set null,
  kind        public.activity_kind not null,
  payload     jsonb                not null default '{}'::jsonb,
  -- Coalescing bucket for 'edit' events so typing never floods the feed.
  bucket      timestamptz,
  created_at  timestamptz          not null default now(),
  updated_at  timestamptz          not null default now()
);

create index if not exists activity_events_doc_idx
  on public.activity_events (document_id, created_at desc);

create unique index if not exists activity_events_edit_bucket_idx
  on public.activity_events (document_id, actor_id, bucket)
  where kind = 'edit';

-- ---------------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'documents', 'document_permissions', 'document_operations',
    'document_versions', 'comments', 'activity_events'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

alter table public.document_operations replica identity full;
alter table public.comments           replica identity full;
alter table public.activity_events    replica identity full;
alter table public.documents          replica identity full;

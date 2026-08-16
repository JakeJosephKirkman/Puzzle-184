-- CollabSpace: core schema
-- Real-time collaborative workspace backed by an append-only CRDT operation log.
--
-- Design note: the durable source of truth for a document is `document_operations`,
-- not `documents.content`. The content column is a materialised convenience snapshot.
-- Replaying the op log always reproduces the document exactly, which is what makes
-- last-write-wins overwrites impossible.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Preflight: refuse to run against somebody else's tables.
--
-- Every object below is namespaced `collab_` so this schema can share a
-- database with other projects. The creates further down are `if not exists`
-- so the migration can be re-run safely -- but that same flag will silently
-- skip a table whose name is already taken, leaving a foreign table wearing
-- our name and producing baffling "column does not exist" errors much later.
--
-- So: if a collab_ table already exists but lacks a column we know ours has,
-- it is not ours. Fail here, loudly, naming the table and the fix.
-- ---------------------------------------------------------------------------

do $$
declare t record;
begin
  for t in select * from (values
      ('collab_profiles',    'display_name'),
      ('collab_documents',   'crdt_state'),
      ('collab_permissions', 'role'),
      ('collab_operations',  'op_id'),
      ('collab_versions',    'crdt_snapshot'),
      ('collab_comments',    'anchor'),
      ('collab_activity',    'bucket')
    ) as v(tbl, col)
  loop
    if to_regclass('public.' || t.tbl) is not null and not exists (
         select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = t.tbl
            and column_name = t.col)
    then
      raise exception
        'public.% already exists but has no % column, so it is not CollabSpace''s table. Rename or remove it before running this migration.',
        t.tbl, t.col;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.collab_role as enum ('owner', 'editor', 'viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.collab_activity_kind as enum ('edit', 'comment', 'join', 'leave', 'restore', 'permission');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.collab_profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text        not null,
  color        text        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------

create table if not exists public.collab_documents (
  id               uuid        primary key default gen_random_uuid(),
  title            text        not null default 'Untitled document',
  owner_id         uuid        not null references auth.users (id) on delete cascade,
  content          text        not null default '',
  crdt_state       jsonb       not null default '{"nodes":[],"marks":[]}'::jsonb,
  -- Optimistic concurrency guard. Bumped only via save_document_snapshot().
  snapshot_version bigint      not null default 0,
  -- Highest operation seq folded into crdt_state, so a client can load the
  -- snapshot and then replay only the operations that came after it.
  snapshot_seq     bigint      not null default 0,
  last_saved_at    timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists collab_documents_owner_idx on public.collab_documents (owner_id);

-- ---------------------------------------------------------------------------
-- document_permissions
-- ---------------------------------------------------------------------------

create table if not exists public.collab_permissions (
  id          uuid          primary key default gen_random_uuid(),
  document_id uuid          not null references public.collab_documents (id) on delete cascade,
  user_id     uuid          not null references auth.users (id) on delete cascade,
  role        public.collab_role not null default 'viewer',
  granted_by  uuid          references auth.users (id) on delete set null,
  created_at  timestamptz   not null default now(),
  unique (document_id, user_id)
);

create index if not exists collab_permissions_user_idx on public.collab_permissions (user_id);

-- ---------------------------------------------------------------------------
-- document_operations  (append-only CRDT log -- the real source of truth)
-- ---------------------------------------------------------------------------

create table if not exists public.collab_operations (
  seq         bigserial   primary key,
  document_id uuid        not null references public.collab_documents (id) on delete cascade,
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

create index if not exists collab_operations_doc_seq_idx
  on public.collab_operations (document_id, seq);

-- ---------------------------------------------------------------------------
-- document_versions
-- ---------------------------------------------------------------------------

create table if not exists public.collab_versions (
  id             uuid        primary key default gen_random_uuid(),
  document_id    uuid        not null references public.collab_documents (id) on delete cascade,
  version_number integer     not null,
  content        text        not null,
  crdt_snapshot  jsonb       not null,
  created_by     uuid        references auth.users (id) on delete set null,
  label          text,
  summary        jsonb       not null default '{}'::jsonb,
  restored_from  uuid        references public.collab_versions (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (document_id, version_number)
);

create index if not exists collab_versions_doc_idx
  on public.collab_versions (document_id, version_number desc);

-- ---------------------------------------------------------------------------
-- comments
-- ---------------------------------------------------------------------------

create table if not exists public.collab_comments (
  id          uuid        primary key default gen_random_uuid(),
  document_id uuid        not null references public.collab_documents (id) on delete cascade,
  parent_id   uuid        references public.collab_comments (id) on delete cascade,
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

create index if not exists collab_comments_doc_idx on public.collab_comments (document_id, created_at);
create index if not exists collab_comments_parent_idx on public.collab_comments (parent_id);

-- ---------------------------------------------------------------------------
-- activity_events
-- ---------------------------------------------------------------------------

create table if not exists public.collab_activity (
  id          uuid                 primary key default gen_random_uuid(),
  document_id uuid                 not null references public.collab_documents (id) on delete cascade,
  actor_id    uuid                 references auth.users (id) on delete set null,
  kind        public.collab_activity_kind not null,
  payload     jsonb                not null default '{}'::jsonb,
  -- Coalescing bucket for 'edit' events so typing never floods the feed.
  bucket      timestamptz,
  created_at  timestamptz          not null default now(),
  updated_at  timestamptz          not null default now()
);

create index if not exists collab_activity_doc_idx
  on public.collab_activity (document_id, created_at desc);

create unique index if not exists collab_activity_edit_bucket_idx
  on public.collab_activity (document_id, actor_id, bucket)
  where kind = 'edit';

-- ---------------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'collab_documents', 'collab_permissions', 'collab_operations',
    'collab_versions', 'collab_comments', 'collab_activity'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

alter table public.collab_operations replica identity full;
alter table public.collab_comments           replica identity full;
alter table public.collab_activity    replica identity full;
alter table public.collab_documents          replica identity full;

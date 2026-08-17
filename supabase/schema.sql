-- ===========================================================================
-- CollabSpace -- complete database setup
--
-- Paste this entire file into the Supabase SQL editor and run it once.
-- It is idempotent: running it again is safe and changes nothing.
--
-- The last section verifies itself and returns a grid of results. Every row
-- should read PASS.
--
-- Contents
--   0. Preflight -- refuse to run against another project's tables
--   1. Extensions and enums
--   2. Tables and indexes
--   3. Realtime publication
--   4. Row level security policies
--   5. Role helper functions
--   6. Activity triggers
--   7. Remote procedures
--   8. Grants
--   9. Self-verification (returns results; never raises)
--  10. Optional demo seed (commented out)
--
-- Design note: the durable source of truth for a document is the append-only
-- `collab_operations` log, not `collab_documents.content`. That column is a
-- materialised snapshot for fast loading. Replaying the log always reproduces
-- the document exactly, which is what makes last-write-wins overwrites
-- impossible -- nothing is ever saved over, operations are merged.
--
-- Every object is namespaced `collab_` so this schema can share a database
-- with other projects without competing for names as generic as `profiles`,
-- `documents` or `comments`.
-- ===========================================================================

-- ===========================================================================
-- 1. Extensions and enums  (section 0, the preflight guard, is inline below)
-- ===========================================================================

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
  id           uuid primary key,
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
  owner_id         uuid        references auth.users (id) on delete set null,
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
  actor_id    uuid        references auth.users (id) on delete set null,
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
  author_id   uuid        references auth.users (id) on delete set null,
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
-- Upgrade: stop user deletion from destroying documents
--
-- These columns were originally `on delete cascade` against auth.users, which
-- meant deleting a user deleted their documents, their rows in the append-only
-- operation log, and their comments. Supabase's own guidance is to prune
-- anonymous users periodically -- following it would have silently destroyed
-- content, and left the operation log unable to replay to the document it
-- produced.
--
-- Authorship becomes null instead. The work survives; only the attribution is
-- lost, and even that is usually recoverable because collab_profiles now
-- outlives the auth account (its FK is dropped below), so the name is retained
-- for the activity feed and the authorship heatmap.
--
-- Written as guarded ALTERs because this schema is already applied to live
-- projects: a fresh install is a no-op, an existing install is repaired.
-- ---------------------------------------------------------------------------

do $$
declare
  t record;
begin
  for t in select * from (values
      ('collab_documents',  'owner_id'),
      ('collab_operations', 'actor_id'),
      ('collab_comments',   'author_id')
    ) as v(tbl, col)
  loop
    if to_regclass('public.' || t.tbl) is null then continue; end if;

    -- Drop whichever FK currently governs the column, whatever it is named.
    execute (
      select coalesce(string_agg(
        format('alter table public.%I drop constraint %I', t.tbl, con.conname), '; '), 'select 1')
      from pg_constraint con
      join pg_attribute att
        on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
      where con.conrelid = to_regclass('public.' || t.tbl)
        and con.contype = 'f'
        and att.attname = t.col
    );

    execute format('alter table public.%I alter column %I drop not null', t.tbl, t.col);
    execute format(
      'alter table public.%I add constraint %I foreign key (%I) references auth.users (id) on delete set null',
      t.tbl, t.tbl || '_' || t.col || '_fkey', t.col);
  end loop;

  -- Profiles outlive the auth account so history stays readable rather than
  -- becoming a wall of entries attributed to nobody.
  if to_regclass('public.collab_profiles') is not null then
    execute (
      select coalesce(string_agg(
        format('alter table public.collab_profiles drop constraint %I', conname), '; '), 'select 1')
      from pg_constraint
      where conrelid = to_regclass('public.collab_profiles') and contype = 'f'
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------------

-- Realtime delivery is a nice-to-have; the operation log in Postgres is the
-- durable record. So nothing in this block may abort the install: an earlier
-- version caught only `duplicate_object`, which meant a project without a
-- `supabase_realtime` publication raised `undefined_object`, and -- because
-- the SQL editor runs this file as one transaction -- rolled the ENTIRE schema
-- back. Losing every table because realtime was not configured is absurd, so
-- every failure mode here degrades to "realtime not wired up" instead.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
exception when insufficient_privilege or duplicate_object then
  null;  -- someone else owns it, or it appeared between the check and the create
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'collab_documents', 'collab_permissions', 'collab_operations',
    'collab_versions', 'collab_comments', 'collab_activity'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;      -- already published
      when undefined_object then null;      -- no publication at all
      when insufficient_privilege then null; -- not ours to alter
    end;
  end loop;
end $$;

alter table public.collab_operations replica identity full;
alter table public.collab_comments           replica identity full;
alter table public.collab_activity    replica identity full;
alter table public.collab_documents          replica identity full;

-- ===========================================================================
-- 4-8. Row level security, helpers, triggers, procedures and grants
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Role helpers
--
-- These are SECURITY DEFINER so they read collab_permissions without going
-- back through RLS. That is what stops the policies on collab_documents and
-- collab_permissions from recursing into each other.
-- ---------------------------------------------------------------------------

create or replace function public.collab_has_access(doc uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.collab_permissions p
    where p.document_id = doc and p.user_id = auth.uid()
  );
$$;

create or replace function public.collab_has_role(doc uuid, roles public.collab_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.collab_permissions p
    where p.document_id = doc
      and p.user_id = auth.uid()
      and p.role = any(roles)
  );
$$;

create or replace function public.collab_can_edit(doc uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.collab_has_role(doc, array['owner', 'editor']::public.collab_role[]);
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS
-- ---------------------------------------------------------------------------

alter table public.collab_profiles             enable row level security;
alter table public.collab_documents            enable row level security;
alter table public.collab_permissions enable row level security;
alter table public.collab_operations  enable row level security;
alter table public.collab_versions    enable row level security;
alter table public.collab_comments             enable row level security;
alter table public.collab_activity      enable row level security;

-- ---------------------------------------------------------------------------
-- profiles: readable by all signed-in users (needed to render collaborator
-- names and avatars); writable only by their owner.
-- ---------------------------------------------------------------------------

drop policy if exists collab_profiles_select on public.collab_profiles;
create policy collab_profiles_select on public.collab_profiles
  for select to authenticated using (true);

drop policy if exists collab_profiles_insert on public.collab_profiles;
create policy collab_profiles_insert on public.collab_profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists collab_profiles_update on public.collab_profiles;
create policy collab_profiles_update on public.collab_profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------

drop policy if exists collab_documents_select on public.collab_documents;
create policy collab_documents_select on public.collab_documents
  for select to authenticated
  using (owner_id = auth.uid() or public.collab_has_access(id));

drop policy if exists collab_documents_insert on public.collab_documents;
create policy collab_documents_insert on public.collab_documents
  for insert to authenticated with check (owner_id = auth.uid());

-- Editors may write the materialised snapshot; viewers may not.
drop policy if exists collab_documents_update on public.collab_documents;
create policy collab_documents_update on public.collab_documents
  for update to authenticated
  using (public.collab_can_edit(id))
  with check (public.collab_can_edit(id));

drop policy if exists collab_documents_delete on public.collab_documents;
create policy collab_documents_delete on public.collab_documents
  for delete to authenticated using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- document_permissions: everyone with access can see who else has access;
-- only the owner may grant, change or revoke.
-- ---------------------------------------------------------------------------

drop policy if exists collab_permissions_select on public.collab_permissions;
create policy collab_permissions_select on public.collab_permissions
  for select to authenticated
  using (user_id = auth.uid() or public.collab_has_access(document_id));

drop policy if exists collab_permissions_insert on public.collab_permissions;
create policy collab_permissions_insert on public.collab_permissions
  for insert to authenticated
  with check (
    public.collab_has_role(document_id, array['owner']::public.collab_role[])
    or exists (
      select 1 from public.collab_documents d
      where d.id = document_id and d.owner_id = auth.uid()
    )
  );

drop policy if exists collab_permissions_update on public.collab_permissions;
create policy collab_permissions_update on public.collab_permissions
  for update to authenticated
  using (public.collab_has_role(document_id, array['owner']::public.collab_role[]))
  with check (public.collab_has_role(document_id, array['owner']::public.collab_role[]));

drop policy if exists collab_permissions_delete on public.collab_permissions;
create policy collab_permissions_delete on public.collab_permissions
  for delete to authenticated
  using (public.collab_has_role(document_id, array['owner']::public.collab_role[]));

-- ---------------------------------------------------------------------------
-- document_operations: the critical one.
--
-- Anyone with access may read the log (they need it to reconstruct the
-- document). Only owners and editors may append to it. A viewer physically
-- cannot write an edit.
--
-- Operations are append-only: no update or delete policy exists at all, so
-- history cannot be rewritten by anyone.
-- ---------------------------------------------------------------------------

drop policy if exists collab_operations_select on public.collab_operations;
create policy collab_operations_select on public.collab_operations
  for select to authenticated using (public.collab_has_access(document_id));

drop policy if exists collab_operations_insert on public.collab_operations;
create policy collab_operations_insert on public.collab_operations
  for insert to authenticated
  with check (actor_id = auth.uid() and public.collab_can_edit(document_id));

-- ---------------------------------------------------------------------------
-- document_versions
-- ---------------------------------------------------------------------------

drop policy if exists collab_versions_select on public.collab_versions;
create policy collab_versions_select on public.collab_versions
  for select to authenticated using (public.collab_has_access(document_id));

drop policy if exists collab_versions_insert on public.collab_versions;
create policy collab_versions_insert on public.collab_versions
  for insert to authenticated
  with check (created_by = auth.uid() and public.collab_can_edit(document_id));

-- ---------------------------------------------------------------------------
-- comments: any role with access may comment and reply, including viewers.
-- Editing a comment is limited to its author; resolving is open to the author
-- or to editors and owners.
-- ---------------------------------------------------------------------------

drop policy if exists collab_comments_select on public.collab_comments;
create policy collab_comments_select on public.collab_comments
  for select to authenticated using (public.collab_has_access(document_id));

drop policy if exists collab_comments_insert on public.collab_comments;
create policy collab_comments_insert on public.collab_comments
  for insert to authenticated
  with check (author_id = auth.uid() and public.collab_has_access(document_id));

drop policy if exists collab_comments_update on public.collab_comments;
create policy collab_comments_update on public.collab_comments
  for update to authenticated
  using (author_id = auth.uid() or public.collab_can_edit(document_id))
  with check (author_id = auth.uid() or public.collab_can_edit(document_id));

drop policy if exists collab_comments_delete on public.collab_comments;
create policy collab_comments_delete on public.collab_comments
  for delete to authenticated
  using (author_id = auth.uid() or public.collab_has_role(document_id, array['owner']::public.collab_role[]));

-- ---------------------------------------------------------------------------
-- activity_events
-- ---------------------------------------------------------------------------

drop policy if exists collab_activity_select on public.collab_activity;
create policy collab_activity_select on public.collab_activity
  for select to authenticated using (public.collab_has_access(document_id));

drop policy if exists collab_activity_insert on public.collab_activity;
create policy collab_activity_insert on public.collab_activity
  for insert to authenticated
  with check (public.collab_has_access(document_id));

drop policy if exists collab_activity_update on public.collab_activity;
create policy collab_activity_update on public.collab_activity
  for update to authenticated
  using (public.collab_has_access(document_id))
  with check (public.collab_has_access(document_id));

-- ---------------------------------------------------------------------------
-- Trigger: coalesce edit activity into one row per actor per minute.
-- Without this, typing a paragraph would produce hundreds of feed entries.
-- ---------------------------------------------------------------------------

create or replace function public.collab_log_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  b timestamptz := date_trunc('minute', now());
begin
  insert into public.collab_activity (document_id, actor_id, kind, bucket, payload)
  values (new.document_id, new.actor_id, 'edit', b, jsonb_build_object('ops', 1))
  on conflict (document_id, actor_id, bucket) where kind = 'edit'
  do update set
    payload = jsonb_set(
      public.collab_activity.payload,
      '{ops}',
      to_jsonb(coalesce((public.collab_activity.payload ->> 'ops')::int, 0) + 1)
    ),
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_collab_log_edit on public.collab_operations;
create trigger trg_collab_log_edit
  after insert on public.collab_operations
  for each row execute function public.collab_log_edit();

-- ---------------------------------------------------------------------------
-- Trigger: comment activity
-- ---------------------------------------------------------------------------

create or replace function public.collab_log_comment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.collab_activity (document_id, actor_id, kind, payload)
  values (
    new.document_id,
    new.author_id,
    'comment',
    jsonb_build_object(
      'comment_id', new.id,
      'is_reply', new.parent_id is not null,
      'excerpt', left(new.body, 120)
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_collab_log_comment on public.collab_comments;
create trigger trg_collab_log_comment
  after insert on public.collab_comments
  for each row execute function public.collab_log_comment();

-- ---------------------------------------------------------------------------
-- Trigger: version restore activity
-- ---------------------------------------------------------------------------

create or replace function public.collab_log_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  src integer;
begin
  if new.restored_from is not null then
    select version_number into src
      from public.collab_versions where id = new.restored_from;

    insert into public.collab_activity (document_id, actor_id, kind, payload)
    values (
      new.document_id, new.created_by, 'restore',
      jsonb_build_object(
        'version_id', new.id,
        'version_number', new.version_number,
        'restored_from_number', src
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_collab_log_version on public.collab_versions;
create trigger trg_collab_log_version
  after insert on public.collab_versions
  for each row execute function public.collab_log_version();

-- ---------------------------------------------------------------------------
-- RPC: save_document_snapshot
--
-- The optimistic-concurrency guard. A client passes the snapshot_version it
-- believes is current; if another client has saved since, the UPDATE matches
-- no row and we raise instead of silently overwriting. The caller then pulls
-- the operations it missed, merges them through the CRDT (always safe) and
-- retries.
--
-- This is the direct answer to "do not simply save whichever request reaches
-- the database last".
-- ---------------------------------------------------------------------------

create or replace function public.collab_save_snapshot(
  doc              uuid,
  expected_version bigint,
  new_content      text,
  new_state        jsonb,
  new_seq          bigint default 0
)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v bigint;
begin
  if not public.collab_can_edit(doc) then
    raise exception 'insufficient_privilege: view-only access'
      using errcode = '42501';
  end if;

  update public.collab_documents
     set content          = new_content,
         crdt_state       = new_state,
         snapshot_seq     = greatest(snapshot_seq, coalesce(new_seq, 0)),
         snapshot_version = snapshot_version + 1,
         last_saved_at    = now(),
         updated_at       = now()
   where id = doc
     and snapshot_version = expected_version
  returning snapshot_version into v;

  if v is null then
    raise exception 'version_conflict: document changed since version %', expected_version
      using errcode = '40001';
  end if;

  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: create_document -- document plus its owner permission row, atomically.
-- ---------------------------------------------------------------------------

create or replace function public.collab_create_document(doc_title text default 'Untitled document')
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  insert into public.collab_documents (title, owner_id)
  values (coalesce(nullif(doc_title, ''), 'Untitled document'), auth.uid())
  returning id into new_id;

  insert into public.collab_permissions (document_id, user_id, role, granted_by)
  values (new_id, auth.uid(), 'owner', auth.uid());

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: join_document
--
-- Opening a share link grants Editor access if the visitor has none yet.
-- This is what lets a second person open the same document at all: without a
-- permission row, RLS correctly refuses to show them anything.
--
-- Deliberate product choice for a link-shareable workspace -- knowing the
-- document id is the invitation. Owners can demote anyone to Viewer afterwards,
-- and a Viewer who calls this keeps their existing role rather than escalating.
-- ---------------------------------------------------------------------------

create or replace function public.collab_join_document(doc uuid)
returns public.collab_role
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.collab_role;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select role into existing
    from public.collab_permissions
   where document_id = doc and user_id = auth.uid();

  -- Never escalates an existing role.
  if existing is not null then
    return existing;
  end if;

  if not exists (select 1 from public.collab_documents where id = doc) then
    raise exception 'document_not_found' using errcode = 'P0002';
  end if;

  insert into public.collab_permissions (document_id, user_id, role)
  values (doc, auth.uid(), 'editor')
  on conflict (document_id, user_id) do nothing;

  insert into public.collab_activity (document_id, actor_id, kind, payload)
  values (doc, auth.uid(), 'join', jsonb_build_object('first_time', true));

  return 'editor'::public.collab_role;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: next_version_number -- gap-free per-document version numbering.
-- ---------------------------------------------------------------------------

create or replace function public.collab_next_version(doc uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(max(version_number), 0) + 1
    from public.collab_versions where document_id = doc;
$$;

-- ---------------------------------------------------------------------------
-- Table privileges
--
-- RLS narrows *within* a privilege; it cannot grant one. Supabase's default
-- privileges usually hand `authenticated` access to everything in `public`,
-- but relying on that leaves this schema dependent on ambient project
-- configuration -- and makes an RLS test pass for the wrong reason, because
-- "permission denied for table" looks identical to a policy refusal.
--
-- Granted table by table on purpose: this database is shared with other
-- projects, so `all tables in schema public` would hand out rights over
-- somebody else's data.
--
-- collab_operations gets SELECT and INSERT only. There is no UPDATE or DELETE
-- privilege and no policy for either, so the operation log is append-only at
-- both layers and history cannot be rewritten.
-- ---------------------------------------------------------------------------

grant select, insert, update                 on public.collab_profiles    to authenticated;
grant select, insert, update, delete         on public.collab_documents   to authenticated;
grant select, insert, update, delete         on public.collab_permissions to authenticated;
grant select, insert                         on public.collab_operations  to authenticated;
grant select, insert                         on public.collab_versions    to authenticated;
grant select, insert, update, delete         on public.collab_comments    to authenticated;
grant select, insert, update                 on public.collab_activity    to authenticated;

grant usage, select on sequence public.collab_operations_seq_seq to authenticated;

grant execute on function public.collab_save_snapshot(uuid, bigint, text, jsonb, bigint) to authenticated;
grant execute on function public.collab_create_document(text) to authenticated;
grant execute on function public.collab_next_version(uuid) to authenticated;
grant execute on function public.collab_join_document(uuid) to authenticated;
grant execute on function public.collab_has_access(uuid) to authenticated;
grant execute on function public.collab_has_role(uuid, public.collab_role[]) to authenticated;
grant execute on function public.collab_can_edit(uuid) to authenticated;

-- ===========================================================================
-- 9. Self-verification
--
-- Everything above is now installed. These checks prove the permission
-- boundary is Postgres and not the user interface -- run automatically so
-- setup either demonstrably works or tells you what is wrong.
--
-- Two design constraints, both learned the hard way:
--
-- 1. Nothing here may RAISE. The Supabase SQL editor runs this file as a
--    single transaction, so a raising assertion would roll back the schema it
--    just created. Failures are recorded, never thrown.
--
-- 2. Every refusal is paired with a POSITIVE CONTROL. A test that only checks
--    "the viewer was refused" passes just as happily when *everyone* is
--    refused for an unrelated reason -- a missing GRANT, a typo'd table -- and
--    would report success while RLS did nothing at all. An earlier version of
--    this file did exactly that. So an editor must be shown to succeed before
--    a viewer failing means anything, and refusals must carry the specific
--    SQLSTATE (42501 for RLS, 40001 for a version conflict).
-- ===========================================================================

drop table if exists collab_check_results;
create temporary table collab_check_results (
  ord    integer,
  check_name text,
  result text,
  detail text
);

do $$
declare
  owner_id  uuid := gen_random_uuid();
  editor_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  outsider  uuid := gen_random_uuid();
  doc_id    uuid;
  st        text;
  visible   integer;
  saved     bigint;
  body      text;
  -- Results accumulate in arrays: the temp table is owned by the session user,
  -- and these checks run as `authenticated`, which has no rights on it.
  ck text[] := '{}';
  rs text[] := '{}';
  dt text[] := '{}';
  i  integer;
begin
  ---------------------------------------------------------------------------
  -- Fixtures. If these fail the schema is still fine -- say so plainly rather
  -- than reporting nine misleading failures.
  ---------------------------------------------------------------------------
  begin
    insert into auth.users (id, aud, role, email) values
      (owner_id,  'authenticated', 'authenticated', 'collab-selftest-' || owner_id  || '@example.invalid'),
      (editor_id, 'authenticated', 'authenticated', 'collab-selftest-' || editor_id || '@example.invalid'),
      (viewer_id, 'authenticated', 'authenticated', 'collab-selftest-' || viewer_id || '@example.invalid'),
      (outsider,  'authenticated', 'authenticated', 'collab-selftest-' || outsider  || '@example.invalid');

    insert into public.collab_profiles (id, display_name, color) values
      (owner_id, 'Self-test Owner', '#8b7bf7'), (editor_id, 'Self-test Editor', '#22c55e'),
      (viewer_id, 'Self-test Viewer', '#f59e0b'), (outsider, 'Self-test Outsider', '#f43f5e');

    insert into public.collab_documents (title, owner_id)
    values ('CollabSpace self-test', owner_id) returning id into doc_id;

    insert into public.collab_permissions (document_id, user_id, role) values
      (doc_id, owner_id, 'owner'), (doc_id, editor_id, 'editor'), (doc_id, viewer_id, 'viewer');
  exception when others then
    insert into collab_check_results
    values (0, 'self-test fixtures', 'SKIP',
            'Schema installed OK, but the self-test could not create rows: ' || SQLERRM);
    return;
  end;

  perform set_config('role', 'authenticated', true);

  ---------------------------------------------------------------------------
  -- 1. POSITIVE CONTROL: an editor may append an operation.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', editor_id)::text, true);
  begin
    insert into public.collab_operations (document_id, actor_id, site_id, lamport, op_id, op)
    values (doc_id, editor_id, 'selftest-editor', 1, 'i:1:selftest-editor',
            '{"t":"ins","id":"1:selftest-editor","ch":"x","left":null}'::jsonb);
    ck := array_append(ck, 'editor CAN append an operation (positive control)'); rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  exception when others then
    ck := array_append(ck, 'editor CAN append an operation (positive control)'); rs := array_append(rs, 'FAIL');
    dt := array_append(dt, (SQLSTATE || ': ' || SQLERRM || ' -- the checks below prove nothing while this fails'));
  end;

  ---------------------------------------------------------------------------
  -- 2. A viewer may NOT append an operation.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', viewer_id)::text, true);
  st := null;
  begin
    insert into public.collab_operations (document_id, actor_id, site_id, lamport, op_id, op)
    values (doc_id, viewer_id, 'selftest-viewer', 2, 'i:2:selftest-viewer',
            '{"t":"ins","id":"2:selftest-viewer","ch":"y","left":null}'::jsonb);
  exception when others then st := SQLSTATE;
  end;
  ck := array_append(ck, 'viewer CANNOT append an operation (42501)');
  if st = '42501' then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  elsif st is null then rs := array_append(rs, 'FAIL'); dt := array_append(dt, 'The insert succeeded -- RLS is not protecting the operation log');
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, ('Refused with ' || st || ', expected 42501 -- refused for the wrong reason'));
  end if;

  ---------------------------------------------------------------------------
  -- 3. A viewer may still read the document.
  ---------------------------------------------------------------------------
  select count(*) into visible from public.collab_documents where id = doc_id;
  ck := array_append(ck, 'viewer CAN read the document');
  if visible = 1 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, 'A viewer cannot read a document they have access to');
  end if;

  ---------------------------------------------------------------------------
  -- 4. A viewer may still comment.
  ---------------------------------------------------------------------------
  ck := array_append(ck, 'viewer CAN comment');
  begin
    insert into public.collab_comments (document_id, author_id, body)
    values (doc_id, viewer_id, 'Viewers are allowed to comment.');
    rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  exception when others then
    rs := array_append(rs, 'FAIL'); dt := array_append(dt, (SQLSTATE || ': ' || SQLERRM));
  end;

  ---------------------------------------------------------------------------
  -- 5. A viewer may NOT save a snapshot.
  ---------------------------------------------------------------------------
  st := null;
  begin
    perform public.collab_save_snapshot(doc_id, 0, 'overwritten by a viewer', '{}'::jsonb, 0);
  exception when others then st := SQLSTATE;
  end;
  ck := array_append(ck, 'viewer CANNOT save a snapshot (42501)');
  if st = '42501' then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, ('Got ' || coalesce(st, 'success') || ', expected 42501'));
  end if;

  ---------------------------------------------------------------------------
  -- 6. Someone with no permission row sees nothing.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', outsider)::text, true);
  select count(*) into visible from public.collab_documents where id = doc_id;
  ck := array_append(ck, 'no permission row -> cannot see the document');
  if visible = 0 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, 'A user with no permission row can read the document');
  end if;

  ---------------------------------------------------------------------------
  -- 7 & 8 & 9. Optimistic concurrency -- the anti-overwrite guarantee.
  --
  -- An editor saving against the version it believes is current succeeds.
  -- Saving again with that same, now stale, number must be REFUSED rather than
  -- clobbering the newer state, and the first writer's content must survive.
  -- This is the whole point of the project, checked in the database.
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', editor_id)::text, true);
  ck := array_append(ck, 'editor saved a snapshot');
  begin
    saved := public.collab_save_snapshot(doc_id, 0, 'first writer wins', '{}'::jsonb, 1);
    rs := array_append(rs, 'PASS'); dt := array_append(dt, ('version is now ' || saved));
  exception when others then
    rs := array_append(rs, 'FAIL'); dt := array_append(dt, (SQLSTATE || ': ' || SQLERRM));
  end;

  st := null;
  begin
    perform public.collab_save_snapshot(doc_id, 0, 'stale writer clobbering', '{}'::jsonb, 1);
  exception when others then st := SQLSTATE;
  end;
  ck := array_append(ck, 'stale writer refused (40001), no overwrite');
  if st = '40001' then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, ('Got ' || coalesce(st, 'success') || ' -- LAST WRITE WON, which is the bug this project exists to prevent'));
  end if;

  select content into body from public.collab_documents where id = doc_id;
  ck := array_append(ck, 'document holds the first writer''s content');
  if body = 'first writer wins' then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, ('Content is "' || coalesce(body, '<null>') || '" -- the stale write landed'));
  end if;

  ---------------------------------------------------------------------------
  -- Back to the session user: record results and clean up the fixtures.
  ---------------------------------------------------------------------------
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', null, true);

  for i in 1 .. coalesce(array_length(ck, 1), 0) loop
    insert into collab_check_results values (i, ck[i], rs[i], dt[i]);
  end loop;

  begin
    delete from public.collab_documents where id = doc_id;
    delete from public.collab_profiles  where id in (owner_id, editor_id, viewer_id, outsider);
    delete from auth.users              where id in (owner_id, editor_id, viewer_id, outsider);
  exception when others then
    insert into collab_check_results
    values (99, 'self-test cleanup', 'WARN', 'Left test rows behind: ' || SQLERRM);
  end;
end $$;

-- The result grid. Every row should read PASS.
select
  check_name as "check",
  result,
  coalesce(detail, '') as detail
from collab_check_results
order by ord;

-- ===========================================================================
-- 10. Optional demo seed
--
-- Uncomment and run AFTER opening the app once, so an anonymous user exists to
-- own the document. Not needed otherwise -- the app's "New Document" button
-- does the same thing.
-- ===========================================================================

-- do $$
-- declare demo_user uuid; doc_id uuid;
-- begin
--   select id into demo_user from auth.users order by created_at desc limit 1;
--   if demo_user is null then
--     raise exception 'No users yet. Open the app once so anonymous sign-in creates one.';
--   end if;
--
--   insert into public.collab_documents (title, owner_id, content)
--   values ('Project Phoenix - Product Requirements', demo_user,
--     E'1. Introduction\n\nProject Phoenix is our next-generation platform designed to help teams collaborate more effectively.\n\n2. Goals\n\nReal-time collaboration across the entire platform.\nSeamless document editing with version history.\n\n3. Functional Requirements\n\n3.1 Real-time Editing\n\nUsers must be able to edit documents simultaneously and see changes instantly. Concurrent edits are merged by a conflict-free replicated data type rather than resolved by last write wins.')
--   returning id into doc_id;
--
--   insert into public.collab_permissions (document_id, user_id, role)
--   values (doc_id, demo_user, 'owner');
--
--   raise notice 'Seeded document %', doc_id;
-- end $$;

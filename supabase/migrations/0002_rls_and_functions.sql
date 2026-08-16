-- CollabSpace: row level security, helper functions, triggers and RPCs.
--
-- RLS is the enforcement layer for permissions. The UI's disabled toolbar is
-- only an affordance -- a viewer who calls the Supabase client directly from
-- devtools is still rejected here, by Postgres.

-- ---------------------------------------------------------------------------
-- Role helpers
--
-- These are SECURITY DEFINER so they read document_permissions without going
-- back through RLS. That is what stops the policies on documents and
-- document_permissions from recursing into each other.
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

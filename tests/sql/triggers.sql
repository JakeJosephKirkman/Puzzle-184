-- Activity trigger tests.
--
-- The activity feed's usefulness rests on one behaviour that lives entirely in
-- the database: edits must be coalesced. Without it, typing a paragraph writes
-- a feed row per keystroke and the feed becomes unreadable. That is a claim
-- about a Postgres trigger, so it is checked in Postgres.
--
-- Run against a database that already has schema.sql applied.

drop table if exists trigger_check_results;
create temporary table trigger_check_results (ord integer, check_name text, result text, detail text);

do $$
declare
  u1 uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  doc uuid;
  parent_comment uuid;
  v1 uuid;
  n integer;
  ops_recorded integer;
  ck text[] := '{}'; rs text[] := '{}'; dt text[] := '{}';
  i integer;
begin
  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 'trg-' || u1 || '@example.invalid'),
    (u2, 'authenticated', 'authenticated', 'trg-' || u2 || '@example.invalid');
  insert into public.collab_profiles (id, display_name, color)
    values (u1, 'Trigger One', '#111'), (u2, 'Trigger Two', '#222');
  insert into public.collab_documents (title, owner_id) values ('trigger probe', u1) returning id into doc;
  insert into public.collab_permissions (document_id, user_id, role)
    values (doc, u1, 'owner'), (doc, u2, 'editor');

  -------------------------------------------------------------------------
  -- 1. A burst of typing collapses into ONE feed entry.
  -------------------------------------------------------------------------
  for i in 1 .. 100 loop
    insert into public.collab_operations (document_id, actor_id, site_id, lamport, op_id, op)
    values (doc, u1, 'burst', i, 'i:' || i || ':burst',
            ('{"t":"ins","id":"' || i || ':burst","ch":"x","left":null}')::jsonb);
  end loop;

  select count(*), max((payload ->> 'ops')::int) into n, ops_recorded
    from public.collab_activity where document_id = doc and kind = 'edit' and actor_id = u1;

  ck := array_append(ck, '100 operations produce exactly 1 feed entry');
  if n = 1 then rs := array_append(rs, 'PASS'); dt := array_append(dt, 'ops counted: ' || ops_recorded);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, n || ' rows -- the feed would be flooded');
  end if;

  ck := array_append(ck, 'the entry counts all 100 operations');
  if ops_recorded = 100 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, 'counted ' || coalesce(ops_recorded, 0));
  end if;

  -------------------------------------------------------------------------
  -- 2. Coalescing is per actor -- two people are two entries, not one.
  -------------------------------------------------------------------------
  insert into public.collab_operations (document_id, actor_id, site_id, lamport, op_id, op)
  values (doc, u2, 'other', 500, 'i:500:other', '{"t":"ins","id":"500:other","ch":"y","left":null}'::jsonb);

  select count(*) into n from public.collab_activity where document_id = doc and kind = 'edit';
  ck := array_append(ck, 'a second editor gets their own entry');
  if n = 2 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, n || ' edit rows, expected 2');
  end if;

  -------------------------------------------------------------------------
  -- 3. Comments and replies.
  -------------------------------------------------------------------------
  insert into public.collab_comments (document_id, author_id, body)
  values (doc, u1, 'a comment') returning id into parent_comment;

  select count(*) into n from public.collab_activity
   where document_id = doc and kind = 'comment' and (payload ->> 'is_reply')::boolean is not true;
  ck := array_append(ck, 'a comment produces one comment event');
  if n = 1 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, n || ' rows, expected 1');
  end if;

  insert into public.collab_comments (document_id, author_id, body, parent_id)
  values (doc, u2, 'a reply', parent_comment);

  select count(*) into n from public.collab_activity
   where document_id = doc and kind = 'comment' and (payload ->> 'is_reply')::boolean is true;
  ck := array_append(ck, 'a reply is flagged as a reply');
  if n = 1 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, n || ' reply rows, expected 1');
  end if;

  -------------------------------------------------------------------------
  -- 4. A restore is recorded, naming the version it came from.
  -------------------------------------------------------------------------
  insert into public.collab_versions (document_id, version_number, content, crdt_snapshot, created_by)
  values (doc, 1, 'v1 content', '{}'::jsonb, u1) returning id into v1;

  select count(*) into n from public.collab_activity where document_id = doc and kind = 'restore';
  ck := array_append(ck, 'an ordinary version does NOT log a restore');
  if n = 0 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, n || ' restore rows before any restore happened');
  end if;

  insert into public.collab_versions (document_id, version_number, content, crdt_snapshot, created_by, restored_from)
  values (doc, 2, 'v1 content again', '{}'::jsonb, u1, v1);

  select count(*) into n from public.collab_activity
   where document_id = doc and kind = 'restore' and (payload ->> 'restored_from_number')::int = 1;
  ck := array_append(ck, 'a restore logs the version it came from');
  if n = 1 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, 'no restore event naming version 1');
  end if;

  for i in 1 .. coalesce(array_length(ck, 1), 0) loop
    insert into trigger_check_results values (i, ck[i], rs[i], dt[i]);
  end loop;

  delete from public.collab_documents where id = doc;
  delete from public.collab_profiles where id in (u1, u2);
  delete from auth.users where id in (u1, u2);
end $$;

select check_name as "check", result, coalesce(detail, '') as detail
from trigger_check_results order by ord;

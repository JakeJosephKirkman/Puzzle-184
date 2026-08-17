-- Deleting a user must not destroy their work.
--
-- These columns were `on delete cascade`, so pruning an anonymous user -- which
-- Supabase's own guidance recommends -- deleted their documents, their rows in
-- the append-only operation log, and their comments. The log could then no
-- longer replay to the document it had produced.
--
-- Run against a database with schema.sql applied.

drop table if exists deletion_check_results;
create temporary table deletion_check_results (ord integer, check_name text, result text, detail text);

do $$
declare
  victim uuid := gen_random_uuid();
  survivor uuid := gen_random_uuid();
  doc uuid;
  n integer;
  owner_now uuid;
  name_now text;
  ck text[] := '{}'; rs text[] := '{}'; dt text[] := '{}';
  i integer;
begin
  insert into auth.users (id, aud, role, email) values
    (victim,   'authenticated', 'authenticated', 'victim-'   || victim   || '@example.invalid'),
    (survivor, 'authenticated', 'authenticated', 'survivor-' || survivor || '@example.invalid');
  insert into public.collab_profiles (id, display_name, color)
    values (victim, 'Deleted Person', '#f43f5e'), (survivor, 'Still Here', '#22c55e');

  insert into public.collab_documents (title, owner_id)
    values ('Document owned by the victim', victim) returning id into doc;
  insert into public.collab_permissions (document_id, user_id, role)
    values (doc, victim, 'owner'), (doc, survivor, 'editor');

  insert into public.collab_operations (document_id, actor_id, site_id, lamport, op_id, op)
  values
    (doc, victim,   'v', 1, 'i:1:v', '{"t":"ins","id":"1:v","ch":"a","left":null}'::jsonb),
    (doc, survivor, 's', 2, 'i:2:s', '{"t":"ins","id":"2:s","ch":"b","left":"1:v"}'::jsonb);

  insert into public.collab_comments (document_id, author_id, body)
    values (doc, victim, 'a comment by the victim');
  insert into public.collab_versions (document_id, version_number, content, crdt_snapshot, created_by)
    values (doc, 1, 'content', '{}'::jsonb, victim);

  -- The event under test.
  delete from auth.users where id = victim;

  select count(*) into n from public.collab_documents where id = doc;
  ck := array_append(ck, 'the document survives');
  if n = 1 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, 'the document was deleted with its owner'); end if;

  select owner_id into owner_now from public.collab_documents where id = doc;
  ck := array_append(ck, 'ownership is cleared, not cascaded');
  if n = 1 and owner_now is null then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, 'owner_id is ' || coalesce(owner_now::text, 'missing row')); end if;

  select count(*) into n from public.collab_operations where document_id = doc;
  ck := array_append(ck, 'the operation log is intact (both operations)');
  if n = 2 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, n || ' operations left -- the log can no longer replay the document'); end if;

  select count(*) into n from public.collab_comments where document_id = doc;
  ck := array_append(ck, 'comments survive');
  if n = 1 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, 'the comment was deleted'); end if;

  select count(*) into n from public.collab_versions where document_id = doc;
  ck := array_append(ck, 'version history survives');
  if n = 1 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, 'versions were deleted'); end if;

  -- The reason the profiles FK was dropped: history stays readable.
  select display_name into name_now from public.collab_profiles where id = victim;
  ck := array_append(ck, 'their name is retained, so history stays readable');
  if name_now = 'Deleted Person' then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, 'the profile went too -- the feed would attribute everything to nobody'); end if;

  select count(*) into n from public.collab_permissions where document_id = doc;
  ck := array_append(ck, 'the surviving collaborator keeps access');
  if n = 1 then rs := array_append(rs, 'PASS'); dt := array_append(dt, null::text);
  else rs := array_append(rs, 'FAIL'); dt := array_append(dt, n || ' permission rows, expected 1'); end if;

  for i in 1 .. coalesce(array_length(ck, 1), 0) loop
    insert into deletion_check_results values (i, ck[i], rs[i], dt[i]);
  end loop;

  delete from public.collab_documents where id = doc;
  delete from public.collab_profiles where id in (victim, survivor);
  delete from auth.users where id = survivor;
end $$;

select check_name as "check", result, coalesce(detail, '') as detail
from deletion_check_results order by ord;

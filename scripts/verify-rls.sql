-- Proof that permissions are enforced by Postgres and not merely by the UI.
--
-- Run in the Supabase SQL editor after applying both migrations.
--
-- Every negative check is paired with a POSITIVE CONTROL. A test that only
-- asserts "the viewer was refused" passes just as happily when everybody is
-- refused for an unrelated reason -- a missing GRANT, a typo'd table name -- and
-- would report success while RLS was doing nothing at all. So each refusal is
-- checked alongside the same action succeeding for someone who should be
-- allowed, and refusals must carry SQLSTATE 42501 specifically.

do $$
declare
  owner_id   uuid := gen_random_uuid();
  editor_id  uuid := gen_random_uuid();
  viewer_id  uuid := gen_random_uuid();
  outsider   uuid := gen_random_uuid();
  doc_id     uuid;
  sqlstate_seen text;
  visible    integer;
  new_version bigint;
  failures   integer := 0;

  procedure_note text;
begin
  -- ---- fixtures -----------------------------------------------------------
  insert into auth.users (id, aud, role, email) values
    (owner_id,  'authenticated', 'authenticated', owner_id  || '@example.test'),
    (editor_id, 'authenticated', 'authenticated', editor_id || '@example.test'),
    (viewer_id, 'authenticated', 'authenticated', viewer_id || '@example.test'),
    (outsider,  'authenticated', 'authenticated', outsider  || '@example.test');

  insert into public.collab_profiles (id, display_name, color) values
    (owner_id, 'RLS Owner', '#8b7bf7'), (editor_id, 'RLS Editor', '#22c55e'),
    (viewer_id, 'RLS Viewer', '#f59e0b'), (outsider, 'RLS Outsider', '#f43f5e');

  insert into public.collab_documents (title, owner_id)
  values ('RLS probe', owner_id) returning id into doc_id;

  insert into public.collab_permissions (document_id, user_id, role) values
    (doc_id, owner_id, 'owner'), (doc_id, editor_id, 'editor'), (doc_id, viewer_id, 'viewer');

  -- ---- 1. POSITIVE CONTROL: an editor may append an operation -------------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', editor_id)::text, true);
  begin
    insert into public.collab_operations (document_id, actor_id, site_id, lamport, op_id, op)
    values (doc_id, editor_id, 'editor-site', 1, 'i:1:editor-site',
            '{"t":"ins","id":"1:editor-site","ch":"x","left":null}'::jsonb);
    raise notice 'PASS  editor CAN append an operation (positive control)';
  exception when others then
    failures := failures + 1;
    raise notice 'FAIL  editor was blocked (%): % -- the negative tests below prove nothing', SQLSTATE, SQLERRM;
  end;

  -- ---- 2. a viewer may NOT append an operation ----------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', viewer_id)::text, true);
  sqlstate_seen := null;
  begin
    insert into public.collab_operations (document_id, actor_id, site_id, lamport, op_id, op)
    values (doc_id, viewer_id, 'viewer-site', 2, 'i:2:viewer-site',
            '{"t":"ins","id":"2:viewer-site","ch":"y","left":null}'::jsonb);
  exception when others then
    sqlstate_seen := SQLSTATE;
  end;

  if sqlstate_seen = '42501' then
    raise notice 'PASS  viewer CANNOT append an operation (refused by RLS, 42501)';
  elsif sqlstate_seen is null then
    failures := failures + 1;
    raise notice 'FAIL  viewer appended an operation -- RLS is not protecting the log';
  else
    failures := failures + 1;
    raise notice 'FAIL  viewer was refused, but with % not 42501 -- wrong reason', sqlstate_seen;
  end if;

  -- ---- 3. a viewer may still READ the document ----------------------------
  select count(*) into visible from public.collab_documents where id = doc_id;
  if visible = 1 then
    raise notice 'PASS  viewer CAN read the document';
  else
    failures := failures + 1;
    raise notice 'FAIL  viewer cannot read the document they have access to';
  end if;

  -- ---- 4. a viewer may still comment --------------------------------------
  begin
    insert into public.collab_comments (document_id, author_id, body)
    values (doc_id, viewer_id, 'Viewers are allowed to comment.');
    raise notice 'PASS  viewer CAN comment';
  exception when others then
    failures := failures + 1;
    raise notice 'FAIL  viewer blocked from commenting (%): %', SQLSTATE, SQLERRM;
  end;

  -- ---- 5. a viewer may NOT save a snapshot --------------------------------
  sqlstate_seen := null;
  begin
    perform public.collab_save_snapshot(doc_id, 0, 'overwritten by a viewer', '{}'::jsonb, 0);
  exception when others then
    sqlstate_seen := SQLSTATE;
  end;
  if sqlstate_seen = '42501' then
    raise notice 'PASS  viewer CANNOT save a snapshot (42501)';
  else
    failures := failures + 1;
    raise notice 'FAIL  viewer snapshot save returned % (expected 42501)', coalesce(sqlstate_seen, 'success');
  end if;

  -- ---- 6. someone with no permission row sees nothing ---------------------
  perform set_config('request.jwt.claims', json_build_object('sub', outsider)::text, true);
  select count(*) into visible from public.collab_documents where id = doc_id;
  if visible = 0 then
    raise notice 'PASS  a user with no permission row cannot see the document';
  else
    failures := failures + 1;
    raise notice 'FAIL  a user with no permission row can read the document';
  end if;

  -- ---- 7. optimistic concurrency: a stale writer is refused ---------------
  -- The core anti-overwrite guarantee. An editor saving against the version it
  -- believes is current succeeds; saving again with that same stale number must
  -- be rejected rather than clobbering the newer state.
  perform set_config('request.jwt.claims', json_build_object('sub', editor_id)::text, true);
  begin
    new_version := public.collab_save_snapshot(doc_id, 0, 'first writer wins', '{}'::jsonb, 1);
    raise notice 'PASS  editor saved snapshot, version is now %', new_version;
  exception when others then
    failures := failures + 1;
    raise notice 'FAIL  editor could not save a snapshot (%): %', SQLSTATE, SQLERRM;
  end;

  sqlstate_seen := null;
  begin
    perform public.collab_save_snapshot(doc_id, 0, 'stale writer clobbering', '{}'::jsonb, 1);
  exception when others then
    sqlstate_seen := SQLSTATE;
  end;
  if sqlstate_seen = '40001' then
    raise notice 'PASS  a stale writer is refused (40001) instead of overwriting';
  else
    failures := failures + 1;
    raise notice 'FAIL  stale save returned % (expected 40001) -- LAST WRITE WON', coalesce(sqlstate_seen, 'success');
  end if;

  select content into procedure_note from public.collab_documents where id = doc_id;
  if procedure_note = 'first writer wins' then
    raise notice 'PASS  document still holds the first writer''s content';
  else
    failures := failures + 1;
    raise notice 'FAIL  document content is "%" -- the stale write landed', procedure_note;
  end if;

  -- ---- teardown -----------------------------------------------------------
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  delete from public.collab_documents where id = doc_id;
  delete from public.collab_profiles where id in (owner_id, editor_id, viewer_id, outsider);
  delete from auth.users where id in (owner_id, editor_id, viewer_id, outsider);

  if failures = 0 then
    raise notice '----------------------------------------------------';
    raise notice 'ALL CHECKS PASSED -- permissions are enforced by Postgres.';
  else
    raise exception '% check(s) FAILED -- see the notices above.', failures;
  end if;
end $$;

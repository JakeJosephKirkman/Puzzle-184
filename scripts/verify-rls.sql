-- Proof that permissions are enforced by Postgres and not merely by the UI.
--
-- Run this in the Supabase SQL editor AFTER applying both migrations. It
-- fabricates an owner and a viewer, then asserts that the viewer is refused
-- when they try to append an operation -- the exact call the browser client
-- makes, with the UI bypassed entirely.

do $$
declare
  owner_id  uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  doc_id    uuid;
  refused   boolean := false;
begin
  -- Stand-in users. (auth.users normally receives these via the auth service.)
  insert into auth.users (id, instance_id, aud, role, email)
  values
    (owner_id,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', owner_id  || '@example.test'),
    (viewer_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', viewer_id || '@example.test');

  insert into public.profiles (id, display_name, color)
  values (owner_id, 'RLS Owner', '#8b7bf7'), (viewer_id, 'RLS Viewer', '#22c55e');

  insert into public.documents (title, owner_id) values ('RLS probe', owner_id) returning id into doc_id;
  insert into public.document_permissions (document_id, user_id, role)
  values (doc_id, owner_id, 'owner'), (doc_id, viewer_id, 'viewer');

  -- Act as the viewer.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated')::text, true);

  begin
    insert into public.document_operations (document_id, actor_id, site_id, lamport, op_id, op)
    values (doc_id, viewer_id, 'probe', 1, 'i:1:probe', '{"t":"ins","id":"1:probe","ch":"x","left":null}'::jsonb);
  exception when insufficient_privilege or others then
    refused := true;
  end;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  if refused then
    raise notice 'PASS: a viewer cannot append operations. RLS is doing its job.';
  else
    raise exception 'FAIL: a viewer inserted an operation. Check the RLS policies.';
  end if;

  -- Clean up the probe.
  delete from public.documents where id = doc_id;
  delete from public.profiles where id in (owner_id, viewer_id);
  delete from auth.users where id in (owner_id, viewer_id);
end $$;

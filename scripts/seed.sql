-- Optional demo content.
--
-- Run this AFTER opening the app once, so an anonymous user exists to own the
-- document. It attaches a sample document to the most recently created user.

do $$
declare
  demo_user uuid;
  doc_id    uuid;
begin
  select id into demo_user from auth.users order by created_at desc limit 1;
  if demo_user is null then
    raise exception 'No users yet. Open the app once so anonymous sign-in creates one.';
  end if;

  insert into public.collab_documents (title, owner_id, content)
  values (
    'Project Phoenix - Product Requirements',
    demo_user,
    E'1. Introduction\n\nProject Phoenix is our next-generation platform designed to help teams collaborate more effectively. This document outlines the core requirements and goals.\n\n2. Goals\n\nReal-time collaboration across the entire platform.\nSeamless document editing with version history.\nPowerful permissions and workspace management.\nComments, mentions and activity tracking.\n\n3. Functional Requirements\n\n3.1 Real-time Editing\n\nUsers must be able to edit documents simultaneously and see changes instantly. Concurrent edits are merged by a conflict-free replicated data type rather than resolved by last write wins.\n\n3.2 Comments\n\nUsers can add comments to any text and reply to existing threads. Comments can be resolved and reopened.'
  )
  returning id into doc_id;

  insert into public.collab_permissions (document_id, user_id, role)
  values (doc_id, demo_user, 'owner');

  insert into public.collab_versions (document_id, version_number, content, crdt_snapshot, created_by, label, summary)
  select doc_id, 1, content, '{"nodes":[],"marks":[],"clock":0}'::jsonb, demo_user, 'Initial draft',
         jsonb_build_object('edits', 0, 'sections', 9)
    from public.collab_documents where id = doc_id;

  raise notice 'Seeded document %', doc_id;
end $$;

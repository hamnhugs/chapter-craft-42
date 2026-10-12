-- LOCAL EDITION ONLY. Applied by scripts/local-up.sh to the Supabase running
-- on this machine; deliberately outside supabase/migrations so it can never
-- reach the hosted project.
--
-- The first account created on this machine is its owner: give it the admin
-- role, which unlocks the operator surfaces (admin panel, operator tier).
-- Later accounts are ordinary users. Idempotent.

create or replace function public.local_first_user_is_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.user_roles where role = 'admin'::public.app_role) then
    insert into public.user_roles (user_id, role) values (new.id, 'admin'::public.app_role)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists local_first_user_is_admin on auth.users;
create trigger local_first_user_is_admin
  after insert on auth.users
  for each row execute function public.local_first_user_is_admin();

-- An account that already exists (e.g. created before this ran) is promoted
-- if nobody is admin yet.
insert into public.user_roles (user_id, role)
select id, 'admin'::public.app_role from auth.users
where not exists (select 1 from public.user_roles where role = 'admin'::public.app_role)
order by created_at
limit 1
on conflict do nothing;

-- =====================================================================
-- Owner admin access + privacy-consent welcome dialog + announcements
-- ---------------------------------------------------------------------
-- 1. Grants the admin role to the app owner's account (and keeps the
--    signup trigger as a fallback if the account is created later).
-- 2. announcements: admin-managed, login-triggered dialogs. The special
--    kind='welcome' row is the first-login privacy statement (clickwrap:
--    requires an explicit accept toggle; acceptance is versioned).
-- 3. announcement_receipts: per-user seen/dismissed/accepted records —
--    this doubles as the legally-relevant consent record (who accepted
--    which policy version, when).
-- 4. admin_audit_log: append-only log of admin access to user content
--    (FTC v. Ring lesson: disclosed admin access must be logged and
--    purposeful, not ambient).
-- 5. Admin RPCs: list every user's neurons (wikis) with owner + entry
--    counts; read a neuron's entries (always audit-logged).
-- Client code already handles the pre-migration state gracefully.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Owner admin grant
--    The existing grant_admin_on_signup trigger (20260529173000) is left
--    untouched; this adds a separate fallback trigger that grants the
--    admin role only to the app owner's account if it signs up later.
-- ---------------------------------------------------------------------
create or replace function public.grant_owner_admin_on_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if lower(new.email) = '4325skyviewdrive@gmail.com' then
    insert into public.user_roles (user_id, role)
    values (new.id, 'admin'::public.app_role)
    on conflict (user_id, role) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists grant_owner_admin_on_signup_trg on auth.users;
create trigger grant_owner_admin_on_signup_trg
  after insert on auth.users
  for each row execute function public.grant_owner_admin_on_signup();

-- Idempotent seed for the case where the owner account already exists.
insert into public.user_roles (user_id, role)
select u.id, 'admin'::public.app_role
from auth.users u
where lower(u.email) = '4325skyviewdrive@gmail.com'
on conflict (user_id, role) do nothing;

-- ---------------------------------------------------------------------
-- 2. Announcements (welcome dialog + splash dialogs)
-- ---------------------------------------------------------------------
create table if not exists public.announcements (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null default 'announcement'
                   check (kind in ('welcome', 'announcement')),
  title          text not null default '',
  body           text not null default '',
  -- GIF / image block. https-only is enforced here AND at render time.
  gif_url        text check (gif_url is null or gif_url like 'https://%'),
  gif_alt        text not null default '',
  gif_clickable  boolean not null default false,
  gif_link_url   text check (gif_link_url is null or gif_link_url like 'https://%'),
  gif_new_tab    boolean not null default true,
  require_ack    boolean not null default false,
  is_active      boolean not null default true,
  priority       integer not null default 0,
  starts_at      timestamptz not null default now(),
  ends_at        timestamptz,
  -- Bumping the version re-prompts everyone (re-consent on material change).
  policy_version integer not null default 1,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.announcements enable row level security;

drop policy if exists "read active announcements" on public.announcements;
create policy "read active announcements"
  on public.announcements for select to authenticated
  using (
    public.is_admin()
    or (is_active and starts_at <= now() and (ends_at is null or ends_at > now()))
  );

drop policy if exists "admin insert announcements" on public.announcements;
create policy "admin insert announcements"
  on public.announcements for insert to authenticated
  with check (public.is_admin());

drop policy if exists "admin update announcements" on public.announcements;
create policy "admin update announcements"
  on public.announcements for update to authenticated
  using (public.is_admin());

drop policy if exists "admin delete announcements" on public.announcements;
create policy "admin delete announcements"
  on public.announcements for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------
-- 3. Per-user receipts (seen / dismissed / accepted) = consent records
-- ---------------------------------------------------------------------
create table if not exists public.announcement_receipts (
  user_id         uuid not null references auth.users (id) on delete cascade,
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  policy_version  integer not null default 1,
  seen_at         timestamptz not null default now(),
  dismissed_at    timestamptz,
  acknowledged_at timestamptz,
  primary key (user_id, announcement_id)
);

create index if not exists announcement_receipts_user_idx
  on public.announcement_receipts (user_id);

alter table public.announcement_receipts enable row level security;

drop policy if exists "read own receipts" on public.announcement_receipts;
create policy "read own receipts"
  on public.announcement_receipts for select to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "insert own receipts" on public.announcement_receipts;
create policy "insert own receipts"
  on public.announcement_receipts for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "update own receipts" on public.announcement_receipts;
create policy "update own receipts"
  on public.announcement_receipts for update to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 4. Append-only admin audit log (written only by SECURITY DEFINER RPCs)
-- ---------------------------------------------------------------------
create table if not exists public.admin_audit_log (
  id             bigint generated by default as identity primary key,
  admin_id       uuid not null,
  action         text not null,
  target_user_id uuid,
  target_id      text,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

alter table public.admin_audit_log enable row level security;

drop policy if exists "admin read audit log" on public.admin_audit_log;
create policy "admin read audit log"
  on public.admin_audit_log for select to authenticated
  using (public.is_admin());
-- No INSERT/UPDATE/DELETE policies: clients can never write or tamper;
-- rows are inserted only inside SECURITY DEFINER functions below.

-- ---------------------------------------------------------------------
-- 5. Admin RPCs
-- ---------------------------------------------------------------------

-- 5a. Every user's neurons with owner email + entry counts (metadata only).
create or replace function public.admin_list_all_wikis()
returns table (
  id uuid, user_id uuid, owner_email text, name text, description text,
  cover_color text, tags text[], is_default boolean, is_meta boolean,
  last_loaded_at timestamptz, created_at timestamptz, updated_at timestamptz,
  entry_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
  select w.id, w.user_id, u.email::text, w.name, w.description, w.cover_color,
         w.tags, w.is_default, w.is_meta, w.last_loaded_at, w.created_at,
         w.updated_at, coalesce(c.cnt, 0)
  from public.wikis w
  join auth.users u on u.id = w.user_id
  left join lateral (
    select count(*) as cnt
    from public.knowledge_entries e
    where e.wiki_id = w.id
  ) c on true
  order by u.email, w.created_at;
end;
$$;

-- 5b. Read a neuron's entries. Content access — always audit-logged.
create or replace function public.admin_list_wiki_entries(_wiki_id uuid, _limit int default 50)
returns table (
  id uuid, title text, content text, entry_type text, tags text[], created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_name  text;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select w.user_id, w.name into v_owner, v_name
  from public.wikis w where w.id = _wiki_id;
  if v_owner is null then
    raise exception 'wiki not found';
  end if;

  insert into public.admin_audit_log (admin_id, action, target_user_id, target_id, detail)
  values (
    auth.uid(), 'view_wiki_entries', v_owner, _wiki_id::text,
    jsonb_build_object('wiki_name', v_name, 'limit', _limit)
  );

  return query
  select e.id, e.title, e.content, e.entry_type, e.tags, e.created_at
  from public.knowledge_entries e
  where e.wiki_id = _wiki_id
  order by e.created_at desc
  limit greatest(coalesce(_limit, 50), 1);
end;
$$;

grant execute on function public.admin_list_all_wikis() to authenticated;
grant execute on function public.admin_list_wiki_entries(uuid, int) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Seed the first-login privacy/welcome dialog (idempotent; admin can
--    edit every field — including the GIF — from the Admin tab).
-- ---------------------------------------------------------------------
insert into public.announcements (kind, title, body, require_ack, priority, is_active)
select
  'welcome',
  'Welcome to Bookworm',
  'Before you dive in, a plain-English note about your privacy.

Bookworm stores the books, notes, and neurons (wikis) you create so the app can work. Your content is not public, but it is not invisible to us: the app''s owner/administrator can view content stored in your account when that is needed to provide support, investigate abuse, keep the service secure, or improve Bookworm. Administrator access to stored content is logged.

When you chat with Counsel, the messages you send (and relevant pieces of your stored content) are processed by the AI model provider you connect (for example OpenRouter), under that provider''s terms.

We do not sell your content. It stays in your account until you delete it or delete your account.

By turning on the accept switch and continuing, you confirm that you have read and accept this privacy statement. We record the date, time, and version of your acceptance.',
  true,
  100,
  true
where not exists (select 1 from public.announcements where kind = 'welcome');

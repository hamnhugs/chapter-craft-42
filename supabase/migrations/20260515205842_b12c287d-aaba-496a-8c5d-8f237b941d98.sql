create table if not exists public.video_jobs (
  id           text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  video_url    text not null,
  status       text not null default 'pending' check (status in ('pending','processing','completed','failed')),
  pdf_url      text,
  transcript   text,
  title        text,
  word_count   integer,
  metadata     jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.video_jobs enable row level security;

create policy "Users can manage their own video jobs"
  on public.video_jobs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists video_jobs_user_id_idx on public.video_jobs(user_id);
create index if not exists video_jobs_status_idx on public.video_jobs(status);
-- =====================================================================
-- Coder Training App: database setup
-- Paste this whole file into the Supabase SQL editor and click "Run".
-- It is safe to run again later (for example after an app update).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  trainer_id    uuid not null references auth.users (id) on delete cascade,
  title         text not null check (length(trim(title)) > 0),
  join_code     text not null unique,
  batch_size    int  not null default 20 check (batch_size between 1 and 1000),
  alpha_target  numeric not null default 0.80 check (alpha_target >= 0 and alpha_target <= 1),
  coder_seq     int  not null default 0,
  created_at    timestamptz not null default now()
);

-- One coder slot. Holds no names and no secrets.
create table if not exists public.coders (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions (id) on delete cascade,
  user_id     uuid references auth.users (id) on delete set null,
  label       text not null,
  joined_at   timestamptz not null default now(),
  unique (session_id, label),
  unique (session_id, user_id)
);

-- Rejoin code and optional name. Only the trainer and the coder can read a row.
create table if not exists public.coder_secrets (
  coder_id     uuid primary key references public.coders (id) on delete cascade,
  session_id   uuid not null references public.sessions (id) on delete cascade,
  rejoin_code  text not null,
  name         text,
  unique (session_id, rejoin_code)
);

-- Failed rejoin attempts, used to slow down guessing. Nobody can read this.
create table if not exists public.rejoin_attempts (
  id            bigint generated always as identity primary key,
  session_id    uuid not null references public.sessions (id) on delete cascade,
  user_id       uuid,
  attempted_at  timestamptz not null default now()
);

create table if not exists public.items (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions (id) on delete cascade,
  ext_id      text not null,
  text        text not null,
  position    int  not null default 0,
  group_label text,
  unique (session_id, ext_id)
);
-- Optional grouping (for example platform). When a session's items have
-- groups, each round draws the batch size from every group.
alter table public.items add column if not exists group_label text;

-- content = {"variables":[{"key","name","instructions",
--            "categories":[{"key","name","definition","examples":[...]}],
--            "worked_examples":[{"text","code","reason"}]}]}
create table if not exists public.codebook_versions (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions (id) on delete cascade,
  version     int  not null,
  content     jsonb not null default '{"variables":[]}'::jsonb,
  notes       text,
  locked      boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (session_id, version)
);

create table if not exists public.rounds (
  id                   uuid primary key default gen_random_uuid(),
  session_id           uuid not null references public.sessions (id) on delete cascade,
  round_no             int  not null,
  codebook_version_id  uuid not null references public.codebook_versions (id) on delete cascade,
  status               text not null default 'open' check (status in ('open', 'closed')),
  opened_at            timestamptz not null default now(),
  closed_at            timestamptz,
  unique (session_id, round_no)
);
-- Only one open round per session.
create unique index if not exists rounds_one_open on public.rounds (session_id) where status = 'open';

create table if not exists public.round_items (
  round_id  uuid not null references public.rounds (id) on delete cascade,
  item_id   uuid not null references public.items (id) on delete cascade,
  position  int  not null,
  primary key (round_id, item_id)
);
create index if not exists round_items_item on public.round_items (item_id);

create table if not exists public.codes (
  round_id      uuid not null references public.rounds (id) on delete cascade,
  item_id       uuid not null references public.items (id) on delete cascade,
  coder_id      uuid not null references public.coders (id) on delete cascade,
  variable_key  text not null,
  category_key  text not null,
  unsure        boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (round_id, item_id, coder_id, variable_key)
);
create index if not exists codes_coder on public.codes (coder_id);

create table if not exists public.submissions (
  round_id      uuid not null references public.rounds (id) on delete cascade,
  coder_id      uuid not null references public.coders (id) on delete cascade,
  submitted_at  timestamptz not null default now(),
  primary key (round_id, coder_id)
);

create table if not exists public.reliability (
  round_id       uuid not null references public.rounds (id) on delete cascade,
  variable_key   text not null,
  n_items        int  not null,
  n_coders       int  not null,
  pct_agreement  numeric,
  alpha          numeric,
  passed         boolean not null default false,
  computed_at    timestamptz not null default now(),
  group_label    text not null default '',
  primary key (round_id, variable_key, group_label)
);
-- group_label '' is the figure for all items; other values are one group each.
-- (The next lines upgrade databases created before groups existed.)
alter table public.reliability add column if not exists group_label text not null default '';
do $$
begin
  if not exists (
    select 1 from information_schema.key_column_usage
    where table_schema = 'public' and table_name = 'reliability'
      and constraint_name = 'reliability_pkey' and column_name = 'group_label'
  ) then
    alter table public.reliability drop constraint reliability_pkey;
    alter table public.reliability add primary key (round_id, variable_key, group_label);
  end if;
end $$;

create table if not exists public.consensus (
  round_id      uuid not null references public.rounds (id) on delete cascade,
  item_id       uuid not null references public.items (id) on delete cascade,
  variable_key  text not null,
  category_key  text,
  status        text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at   timestamptz,
  primary key (round_id, item_id, variable_key)
);

-- author_coder_id is null when the trainer wrote the comment or flag.
create table if not exists public.comments (
  id               uuid primary key default gen_random_uuid(),
  round_id         uuid not null references public.rounds (id) on delete cascade,
  item_id          uuid not null references public.items (id) on delete cascade,
  variable_key     text not null,
  author_coder_id  uuid references public.coders (id) on delete cascade,
  body             text not null check (length(trim(body)) > 0),
  created_at       timestamptz not null default now()
);
create index if not exists comments_card on public.comments (round_id, item_id, variable_key);

create table if not exists public.codebook_flags (
  id               uuid primary key default gen_random_uuid(),
  round_id         uuid not null references public.rounds (id) on delete cascade,
  item_id          uuid not null references public.items (id) on delete cascade,
  variable_key     text not null,
  author_coder_id  uuid references public.coders (id) on delete cascade,
  note             text,
  created_at       timestamptz not null default now()
);
create index if not exists codebook_flags_card on public.codebook_flags (round_id, item_id, variable_key);

-- ---------------------------------------------------------------------
-- 2. Helper functions (used by the security policies)
-- ---------------------------------------------------------------------

create or replace function public.auth_is_trainer(p_session_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from sessions where id = p_session_id and trainer_id = auth.uid());
$$;

create or replace function public.auth_coder_id(p_session_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from coders where session_id = p_session_id and user_id = auth.uid();
$$;

create or replace function public.auth_is_member(p_session_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.auth_is_trainer(p_session_id) or public.auth_coder_id(p_session_id) is not null;
$$;

create or replace function public.round_sid(p_round_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select session_id from rounds where id = p_round_id;
$$;

create or replace function public.round_is_closed(p_round_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from rounds where id = p_round_id and status = 'closed');
$$;

-- True when this coder slot belongs to the caller, the round is open,
-- and the coder has not yet submitted.
create or replace function public.can_code(p_round_id uuid, p_coder_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from rounds r
    join coders c on c.session_id = r.session_id
    where r.id = p_round_id
      and r.status = 'open'
      and c.id = p_coder_id
      and c.user_id = auth.uid()
      and not exists (select 1 from submissions s where s.round_id = r.id and s.coder_id = c.id)
  );
$$;

create or replace function public.label_for(n int) returns text
language plpgsql immutable as $$
declare
  s text := '';
  m int := n;
begin
  while m > 0 loop
    m := m - 1;
    s := chr(65 + (m % 26)) || s;
    m := m / 26;
  end loop;
  return s;
end $$;

-- Random code from letters and digits that are hard to confuse (no 0/O, 1/I/L).
create or replace function public.random_code(n int) returns text
language plpgsql volatile as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  s text := '';
begin
  for i in 1..n loop
    s := s || substr(alphabet, 1 + (get_byte(uuid_send(gen_random_uuid()), 0) % length(alphabet)), 1);
  end loop;
  return s;
end $$;

-- ---------------------------------------------------------------------
-- 3. Trigger: every code must point at an item in the round's batch and
--    a category in the round's codebook version.
-- ---------------------------------------------------------------------

create or replace function public.codes_validate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from round_items where round_id = new.round_id and item_id = new.item_id) then
    raise exception 'This item is not part of the round.';
  end if;
  if not exists (
    select 1
    from rounds r
    join codebook_versions cv on cv.id = r.codebook_version_id
    cross join lateral jsonb_array_elements(cv.content -> 'variables') v
    cross join lateral jsonb_array_elements(v -> 'categories') c
    where r.id = new.round_id
      and v ->> 'key' = new.variable_key
      and c ->> 'key' = new.category_key
  ) then
    raise exception 'This category is not in the codebook for the round.';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists codes_validate on public.codes;
create trigger codes_validate before insert or update on public.codes
  for each row execute function public.codes_validate();

-- ---------------------------------------------------------------------
-- 4. RPC functions (the only way to do the sensitive steps)
-- ---------------------------------------------------------------------

-- Trainer: create a session. Coders (anonymous users) cannot.
create or replace function public.create_session(
  p_title text, p_batch_size int default 20, p_alpha_target numeric default 0.80
) returns public.sessions
language plpgsql security definer set search_path = public as $$
declare
  v_code text;
  v_row sessions;
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in with your email to create a session.';
  end if;
  loop
    v_code := random_code(6);
    exit when not exists (select 1 from sessions where join_code = v_code);
  end loop;
  insert into sessions (trainer_id, title, join_code, batch_size, alpha_target)
  values (auth.uid(), trim(p_title), v_code, p_batch_size, p_alpha_target)
  returning * into v_row;
  return v_row;
end $$;

-- Coder: join with the session code and a name (only the trainer sees the name).
-- Returns the label and personal rejoin code.
-- Calling it again from the same browser returns the same slot.
create or replace function public.join_session(p_join_code text, p_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_session sessions;
  v_coder coders;
  v_label text;
  v_rejoin text;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  select * into v_session from sessions where join_code = upper(trim(p_join_code)) for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'No session matches that code.');
  end if;

  select * into v_coder from coders where session_id = v_session.id and user_id = v_uid;
  if found then
    select rejoin_code into v_rejoin from coder_secrets where coder_id = v_coder.id;
  else
    if nullif(trim(coalesce(p_name, '')), '') is null then
      return jsonb_build_object('ok', false, 'error', 'Enter your name. Only the trainer will see it.');
    end if;
    update sessions set coder_seq = coder_seq + 1 where id = v_session.id
      returning label_for(coder_seq) into v_label;
    insert into coders (session_id, user_id, label) values (v_session.id, v_uid, v_label)
      returning * into v_coder;
    loop
      v_rejoin := v_label || '-' || random_code(4);
      exit when not exists (
        select 1 from coder_secrets where session_id = v_session.id and rejoin_code = v_rejoin);
    end loop;
    insert into coder_secrets (coder_id, session_id, rejoin_code, name)
    values (v_coder.id, v_session.id, v_rejoin, nullif(trim(p_name), ''));
  end if;

  return jsonb_build_object(
    'ok', true, 'session_id', v_session.id, 'title', v_session.title,
    'coder_id', v_coder.id, 'label', v_coder.label, 'rejoin_code', v_rejoin);
end $$;

-- Coder on a new device: session code + rejoin code moves the existing slot
-- (and its saved work) to this browser. The old browser loses access.
create or replace function public.rejoin_session(p_join_code text, p_rejoin_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_session sessions;
  v_target coders;
  v_mine coders;
  v_fails int;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  select * into v_session from sessions where join_code = upper(trim(p_join_code)) for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'No session matches that code.');
  end if;

  select count(*) into v_fails from rejoin_attempts
  where session_id = v_session.id and attempted_at > now() - interval '15 minutes';
  if v_fails >= 10 then
    return jsonb_build_object('ok', false, 'error',
      'Too many wrong rejoin codes for this session. Wait 15 minutes and try again.');
  end if;

  select c.* into v_target
  from coders c join coder_secrets s on s.coder_id = c.id
  where c.session_id = v_session.id and s.rejoin_code = upper(trim(p_rejoin_code));
  if not found then
    insert into rejoin_attempts (session_id, user_id) values (v_session.id, v_uid);
    return jsonb_build_object('ok', false, 'error', 'That rejoin code does not match this session.');
  end if;

  if v_target.user_id is distinct from v_uid then
    -- If this browser already holds a different, unused slot, drop it.
    select * into v_mine from coders where session_id = v_session.id and user_id = v_uid;
    if found then
      if exists (select 1 from codes where coder_id = v_mine.id)
         or exists (select 1 from comments where author_coder_id = v_mine.id)
         or exists (select 1 from codebook_flags where author_coder_id = v_mine.id) then
        return jsonb_build_object('ok', false, 'error',
          'This browser already has saved work as coder ' || v_mine.label || '.');
      end if;
      delete from coders where id = v_mine.id;
    end if;
    update coders set user_id = v_uid where id = v_target.id;
  end if;

  return jsonb_build_object(
    'ok', true, 'session_id', v_session.id, 'title', v_session.title,
    'coder_id', v_target.id, 'label', v_target.label, 'rejoin_code', upper(trim(p_rejoin_code)));
end $$;

-- Coder: the sessions this browser belongs to.
create or replace function public.my_coder_slots()
returns table (session_id uuid, title text, coder_id uuid, label text, rejoin_code text)
language sql stable security definer set search_path = public as $$
  select s.id, s.title, c.id, c.label, cs.rejoin_code
  from coders c
  join sessions s on s.id = c.session_id
  join coder_secrets cs on cs.coder_id = c.id
  where c.user_id = auth.uid()
  order by c.joined_at desc;
$$;

-- Trainer: start the next round with a fresh random batch of unused items
-- (batch_size items, or batch_size from each group when items have groups).
create or replace function public.start_round(p_session_id uuid, p_codebook_version_id uuid)
returns public.rounds
language plpgsql security definer set search_path = public as $$
declare
  v_session sessions;
  v_cb codebook_versions;
  v_round rounds;
  v_n int;
begin
  select * into v_session from sessions where id = p_session_id and trainer_id = auth.uid() for update;
  if not found then
    raise exception 'Only the trainer can start a round.';
  end if;
  if exists (select 1 from rounds where session_id = p_session_id and status = 'open') then
    raise exception 'Close the current round before starting a new one.';
  end if;
  select * into v_cb from codebook_versions where id = p_codebook_version_id and session_id = p_session_id;
  if not found then
    raise exception 'Codebook version not found.';
  end if;
  if coalesce(jsonb_array_length(v_cb.content -> 'variables'), 0) = 0 or exists (
    select 1 from jsonb_array_elements(v_cb.content -> 'variables') v
    where coalesce(jsonb_array_length(v -> 'categories'), 0) < 2
  ) then
    raise exception 'The codebook needs at least one variable, and every variable needs at least two categories.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_cb.content -> 'variables') v
    where coalesce(v ->> 'key', '') = '' or exists (
      select 1 from jsonb_array_elements(v -> 'categories') c where coalesce(c ->> 'key', '') = '')
  ) then
    raise exception 'Every variable and category in the codebook needs a name.';
  end if;

  insert into rounds (session_id, round_no, codebook_version_id)
  values (p_session_id,
          (select coalesce(max(round_no), 0) + 1 from rounds where session_id = p_session_id),
          p_codebook_version_id)
  returning * into v_round;

  -- Draw batch_size unused items at random from every group. A dataset
  -- without groups is one group, so it simply gets batch_size items.
  insert into round_items (round_id, item_id, position)
  select v_round.id, picked.id, row_number() over (order by random())
  from (
    select ranked.id
    from (
      select i.id,
             row_number() over (partition by coalesce(i.group_label, '') order by random()) as rn
      from items i
      where i.session_id = p_session_id
        and not exists (select 1 from round_items ri where ri.item_id = i.id)
    ) ranked
    where ranked.rn <= v_session.batch_size
  ) picked;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'No unused items are left. Upload more items first.';
  end if;

  update codebook_versions set locked = true where id = p_codebook_version_id;
  return v_round;
end $$;

-- Trainer: how many items each group has, and how many are still unused.
create or replace function public.session_item_counts(p_session_id uuid)
returns table (group_label text, total bigint, unused bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from sessions where id = p_session_id and trainer_id = auth.uid()) then
    raise exception 'Only the trainer can see item counts.';
  end if;
  return query
    select coalesce(i.group_label, ''),
           count(*),
           count(*) filter (where not exists (select 1 from round_items ri where ri.item_id = i.id))
    from items i
    where i.session_id = p_session_id
    group by 1
    order by 1;
end $$;

-- Coder: lock my answers for this round.
create or replace function public.submit_round(p_round_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_coder uuid;
begin
  select c.id into v_coder
  from rounds r join coders c on c.session_id = r.session_id
  where r.id = p_round_id and r.status = 'open' and c.user_id = auth.uid();
  if v_coder is null then
    raise exception 'This round is not open for you.';
  end if;
  insert into submissions (round_id, coder_id) values (p_round_id, v_coder)
  on conflict do nothing;
end $$;

-- Trainer: let a coder edit again after an accidental submit (open rounds only).
create or replace function public.reopen_submission(p_round_id uuid, p_coder_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from rounds r join sessions s on s.id = r.session_id
    where r.id = p_round_id and r.status = 'open' and s.trainer_id = auth.uid()
  ) then
    raise exception 'Only the trainer can do this, and only while the round is open.';
  end if;
  delete from submissions where round_id = p_round_id and coder_id = p_coder_id;
end $$;

-- Trainer: close the round. Codes freeze and become visible for review.
create or replace function public.close_round(p_round_id uuid) returns public.rounds
language plpgsql security definer set search_path = public as $$
declare
  v_round rounds;
begin
  update rounds r set status = 'closed', closed_at = now()
  from sessions s
  where r.id = p_round_id and r.status = 'open'
    and s.id = r.session_id and s.trainer_id = auth.uid()
  returning r.* into v_round;
  if not found then
    raise exception 'Only the trainer can close an open round.';
  end if;
  return v_round;
end $$;

-- Trainer: progress counts per coder, without showing any codes.
create or replace function public.round_progress(p_round_id uuid)
returns table (coder_id uuid, label text, codes_done bigint, codes_total bigint, submitted_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  v_round rounds;
  v_total bigint;
begin
  select r.* into v_round from rounds r join sessions s on s.id = r.session_id
  where r.id = p_round_id and s.trainer_id = auth.uid();
  if not found then
    raise exception 'Only the trainer can see progress.';
  end if;
  select (select count(*) from round_items ri where ri.round_id = p_round_id)
       * jsonb_array_length(cv.content -> 'variables')
    into v_total
  from codebook_versions cv where cv.id = v_round.codebook_version_id;

  return query
    select c.id, c.label,
           (select count(*) from codes k where k.round_id = p_round_id and k.coder_id = c.id),
           v_total,
           (select s.submitted_at from submissions s where s.round_id = p_round_id and s.coder_id = c.id)
    from coders c
    where c.session_id = v_round.session_id
    order by c.joined_at;
end $$;

-- ---------------------------------------------------------------------
-- 5. Row Level Security: everything is denied unless a policy allows it.
-- ---------------------------------------------------------------------

alter table public.sessions          enable row level security;
alter table public.coders            enable row level security;
alter table public.coder_secrets     enable row level security;
alter table public.rejoin_attempts   enable row level security;
alter table public.items             enable row level security;
alter table public.codebook_versions enable row level security;
alter table public.rounds            enable row level security;
alter table public.round_items       enable row level security;
alter table public.codes             enable row level security;
alter table public.submissions       enable row level security;
alter table public.reliability       enable row level security;
alter table public.consensus         enable row level security;
alter table public.comments          enable row level security;
alter table public.codebook_flags    enable row level security;

-- sessions: trainer manages own; coders read the sessions they joined.
drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions for select to authenticated
  using (trainer_id = (select auth.uid()) or public.auth_coder_id(id) is not null);
drop policy if exists sessions_update on public.sessions;
create policy sessions_update on public.sessions for update to authenticated
  using (trainer_id = (select auth.uid())) with check (trainer_id = (select auth.uid()));
drop policy if exists sessions_delete on public.sessions;
create policy sessions_delete on public.sessions for delete to authenticated
  using (trainer_id = (select auth.uid()));

-- coders: members see labels (the user_id column is never exposed, see grants).
drop policy if exists coders_select on public.coders;
create policy coders_select on public.coders for select to authenticated
  using (public.auth_is_member(session_id));

-- coder_secrets: trainer sees all in the session; a coder sees only their own.
drop policy if exists coder_secrets_select on public.coder_secrets;
create policy coder_secrets_select on public.coder_secrets for select to authenticated
  using (public.auth_is_trainer(session_id) or coder_id = public.auth_coder_id(session_id));

-- items: trainer manages (items already used in a round cannot be deleted);
-- coders read only items that are in a round's batch.
drop policy if exists items_select on public.items;
create policy items_select on public.items for select to authenticated
  using (
    public.auth_is_trainer(session_id)
    or (public.auth_coder_id(session_id) is not null
        and exists (select 1 from public.round_items ri where ri.item_id = items.id))
  );
drop policy if exists items_insert on public.items;
create policy items_insert on public.items for insert to authenticated
  with check (public.auth_is_trainer(session_id));
drop policy if exists items_delete on public.items;
create policy items_delete on public.items for delete to authenticated
  using (
    public.auth_is_trainer(session_id)
    and not exists (select 1 from public.round_items ri where ri.item_id = items.id)
  );

-- codebook_versions: trainer edits drafts; coders read versions used by a round.
drop policy if exists codebook_select on public.codebook_versions;
create policy codebook_select on public.codebook_versions for select to authenticated
  using (public.auth_is_trainer(session_id) or (locked and public.auth_is_member(session_id)));
drop policy if exists codebook_insert on public.codebook_versions;
create policy codebook_insert on public.codebook_versions for insert to authenticated
  with check (public.auth_is_trainer(session_id) and not locked);
drop policy if exists codebook_update on public.codebook_versions;
create policy codebook_update on public.codebook_versions for update to authenticated
  using (public.auth_is_trainer(session_id) and not locked)
  with check (public.auth_is_trainer(session_id) and not locked);
drop policy if exists codebook_delete on public.codebook_versions;
create policy codebook_delete on public.codebook_versions for delete to authenticated
  using (public.auth_is_trainer(session_id) and not locked);

-- rounds and batches: members read; changes only through the RPC functions.
drop policy if exists rounds_select on public.rounds;
create policy rounds_select on public.rounds for select to authenticated
  using (public.auth_is_member(session_id));
drop policy if exists round_items_select on public.round_items;
create policy round_items_select on public.round_items for select to authenticated
  using (public.auth_is_member(public.round_sid(round_id)));

-- codes: BLIND CODING. A coder reads only their own codes until the round is
-- closed. The trainer also reads nothing until the round is closed.
drop policy if exists codes_select on public.codes;
create policy codes_select on public.codes for select to authenticated
  using (
    coder_id = public.auth_coder_id(public.round_sid(round_id))
    or (public.round_is_closed(round_id) and public.auth_is_member(public.round_sid(round_id)))
  );
drop policy if exists codes_insert on public.codes;
create policy codes_insert on public.codes for insert to authenticated
  with check (public.can_code(round_id, coder_id));
drop policy if exists codes_update on public.codes;
create policy codes_update on public.codes for update to authenticated
  using (public.can_code(round_id, coder_id)) with check (public.can_code(round_id, coder_id));
drop policy if exists codes_delete on public.codes;
create policy codes_delete on public.codes for delete to authenticated
  using (public.can_code(round_id, coder_id));

-- submissions: trainer sees all; a coder sees their own.
drop policy if exists submissions_select on public.submissions;
create policy submissions_select on public.submissions for select to authenticated
  using (
    public.auth_is_trainer(public.round_sid(round_id))
    or coder_id = public.auth_coder_id(public.round_sid(round_id))
  );

-- reliability and consensus: trainer writes after close; members read.
drop policy if exists reliability_select on public.reliability;
create policy reliability_select on public.reliability for select to authenticated
  using (public.auth_is_member(public.round_sid(round_id)));
drop policy if exists reliability_write on public.reliability;
create policy reliability_write on public.reliability for all to authenticated
  using (public.auth_is_trainer(public.round_sid(round_id)) and public.round_is_closed(round_id))
  with check (public.auth_is_trainer(public.round_sid(round_id)) and public.round_is_closed(round_id));

drop policy if exists consensus_select on public.consensus;
create policy consensus_select on public.consensus for select to authenticated
  using (public.auth_is_member(public.round_sid(round_id)));
drop policy if exists consensus_write on public.consensus;
create policy consensus_write on public.consensus for all to authenticated
  using (public.auth_is_trainer(public.round_sid(round_id)) and public.round_is_closed(round_id))
  with check (public.auth_is_trainer(public.round_sid(round_id)) and public.round_is_closed(round_id));

-- comments and codebook flags: members read; add as yourself, closed rounds only.
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select to authenticated
  using (public.auth_is_member(public.round_sid(round_id)));
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated
  with check (
    public.round_is_closed(round_id)
    and (
      (author_coder_id is null and public.auth_is_trainer(public.round_sid(round_id)))
      or author_coder_id = public.auth_coder_id(public.round_sid(round_id))
    )
  );

drop policy if exists flags_select on public.codebook_flags;
create policy flags_select on public.codebook_flags for select to authenticated
  using (public.auth_is_member(public.round_sid(round_id)));
drop policy if exists flags_insert on public.codebook_flags;
create policy flags_insert on public.codebook_flags for insert to authenticated
  with check (
    public.round_is_closed(round_id)
    and (
      (author_coder_id is null and public.auth_is_trainer(public.round_sid(round_id)))
      or author_coder_id = public.auth_coder_id(public.round_sid(round_id))
    )
  );
drop policy if exists flags_delete on public.codebook_flags;
create policy flags_delete on public.codebook_flags for delete to authenticated
  using (
    public.auth_is_trainer(public.round_sid(round_id))
    or author_coder_id = public.auth_coder_id(public.round_sid(round_id))
  );

-- ---------------------------------------------------------------------
-- 6. Grants: signed-in users (trainers and anonymous coders) get only what
--    the policies above are written for. Visitors who are not signed in
--    get nothing.
-- ---------------------------------------------------------------------

revoke all on
  public.sessions, public.coders, public.coder_secrets, public.rejoin_attempts,
  public.items, public.codebook_versions, public.rounds, public.round_items,
  public.codes, public.submissions, public.reliability, public.consensus,
  public.comments, public.codebook_flags
from anon, authenticated;

grant select, delete on public.sessions to authenticated;
grant update (title, batch_size, alpha_target) on public.sessions to authenticated;
grant select (id, session_id, label, joined_at) on public.coders to authenticated;
grant select on public.coder_secrets to authenticated;
grant select, insert, delete on public.items to authenticated;
grant select, insert, delete on public.codebook_versions to authenticated;
grant update (content, notes) on public.codebook_versions to authenticated;
grant select on public.rounds, public.round_items, public.submissions to authenticated;
grant select, insert, update, delete on public.codes to authenticated;
grant select, insert, update, delete on public.reliability, public.consensus to authenticated;
grant select, insert on public.comments to authenticated;
grant select, insert, delete on public.codebook_flags to authenticated;

revoke all on function
  public.auth_is_trainer(uuid), public.auth_coder_id(uuid), public.auth_is_member(uuid),
  public.round_sid(uuid), public.round_is_closed(uuid), public.can_code(uuid, uuid),
  public.label_for(int), public.random_code(int), public.codes_validate(),
  public.create_session(text, int, numeric), public.join_session(text, text),
  public.rejoin_session(text, text), public.my_coder_slots(),
  public.start_round(uuid, uuid), public.submit_round(uuid),
  public.reopen_submission(uuid, uuid), public.close_round(uuid), public.round_progress(uuid),
  public.session_item_counts(uuid)
from public, anon;

grant execute on function
  public.auth_is_trainer(uuid), public.auth_coder_id(uuid), public.auth_is_member(uuid),
  public.round_sid(uuid), public.round_is_closed(uuid), public.can_code(uuid, uuid),
  public.create_session(text, int, numeric), public.join_session(text, text),
  public.rejoin_session(text, text), public.my_coder_slots(),
  public.start_round(uuid, uuid), public.submit_round(uuid),
  public.reopen_submission(uuid, uuid), public.close_round(uuid), public.round_progress(uuid),
  public.session_item_counts(uuid)
to authenticated;

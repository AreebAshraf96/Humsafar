create table public.ride_messages (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index ride_messages_ride_created_idx
  on public.ride_messages (ride_id, created_at);

alter table public.ride_messages enable row level security;

revoke all on public.ride_messages from anon, authenticated;
grant select, insert on public.ride_messages to authenticated;
grant select (id, name) on public.profiles to authenticated;

-- The app sends the user's JWT to this endpoint, so these checks run as the
-- authenticated user and never require exposing a service-role key.
create or replace function public.can_read_ride_chat(p_ride_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.rides r
    where r.id = p_ride_id and (
      r.driver = auth.uid() or exists (
        select 1 from public.bookings b
        where b.ride = r.id and b.passenger = auth.uid() and b.status = 'approved'
      )
    )
  );
$$;

create or replace function public.can_send_ride_chat(p_ride_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.rides r
    where r.id = p_ride_id and r.status in ('scheduled', 'enroute', 'arrived', 'started') and (
      r.driver = auth.uid() or exists (
        select 1 from public.bookings b
        where b.ride = r.id and b.passenger = auth.uid() and b.status = 'approved'
      )
    )
  );
$$;

revoke all on function public.can_read_ride_chat(uuid), public.can_send_ride_chat(uuid) from public, anon;
grant execute on function public.can_read_ride_chat(uuid), public.can_send_ride_chat(uuid) to authenticated;

create policy "ride participants read chat messages"
  on public.ride_messages for select to authenticated
  using (public.can_read_ride_chat(ride_id));

create policy "active ride participants send chat messages"
  on public.ride_messages for insert to authenticated
  with check (sender_id = auth.uid() and public.can_send_ride_chat(ride_id));

-- Per-message read receipts. A user can mark only another participant's
-- messages as read, and only members of that ride can inspect its receipts.
create table if not exists public.ride_message_reads (
  ride_id uuid not null references public.rides(id) on delete cascade,
  message_id uuid not null references public.ride_messages(id) on delete cascade,
  reader_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, reader_id)
);

create index if not exists ride_message_reads_ride_message_idx
  on public.ride_message_reads (ride_id, message_id);

alter table public.ride_message_reads enable row level security;
revoke all on public.ride_message_reads from anon, authenticated;
grant select, insert on public.ride_message_reads to authenticated;

drop policy if exists "ride participants view chat read receipts" on public.ride_message_reads;
create policy "ride participants view chat read receipts"
  on public.ride_message_reads for select to authenticated
  using (public.can_read_ride_chat(ride_id));

drop policy if exists "participants mark incoming messages read" on public.ride_message_reads;
create policy "participants mark incoming messages read"
  on public.ride_message_reads for insert to authenticated
  with check (
    reader_id = auth.uid()
    and public.can_read_ride_chat(ride_id)
    and exists (
      select 1 from public.ride_messages m
      where m.id = message_id
        and m.ride_id = ride_message_reads.ride_id
        and m.sender_id <> auth.uid()
    )
  );

-- The caller can notify only the other members of a ride they can access.
create or replace function public.humsafar_chat_notification_targets(p_ride_id uuid)
returns table (user_id uuid)
language sql stable security definer set search_path = '' as $$
  select r.driver as user_id
  from public.rides r
  where r.id = p_ride_id
    and r.driver <> auth.uid()
    and public.can_read_ride_chat(p_ride_id)
  union
  select b.passenger as user_id
  from public.bookings b
  where b.ride = p_ride_id
    and b.status = 'approved'
    and b.passenger <> auth.uid()
    and public.can_read_ride_chat(p_ride_id);
$$;

revoke all on function public.humsafar_chat_notification_targets(uuid) from public, anon;
grant execute on function public.humsafar_chat_notification_targets(uuid) to authenticated;

alter table public.notification_settings
  add column if not exists chat_messages boolean not null default true;

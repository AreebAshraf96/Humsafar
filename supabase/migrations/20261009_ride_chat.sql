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

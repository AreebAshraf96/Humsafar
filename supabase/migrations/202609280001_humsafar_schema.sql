-- Humsafar application schema for Supabase Postgres.
-- Run in the Supabase SQL Editor or apply with `supabase db push`.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  gender text not null default 'Not specified' check (gender in ('Woman','Man','Non-binary','Not specified')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profile_private (
  id uuid primary key references public.profiles(id) on delete cascade,
  phone text not null default '' check (phone = '' or phone ~ '^\+92[0-9]{10}$')
);
alter table public.profile_private enable row level security;
revoke all on public.profile_private from anon, authenticated;
grant select, insert, update on public.profile_private to authenticated;
create policy "users manage only their private contact details" on public.profile_private for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

create table if not exists public.rides (
  id uuid primary key default gen_random_uuid(),
  driver uuid not null references public.profiles(id) on delete restrict,
  service_city text,
  origin_point jsonb,
  destination_point jsonb,
  origin text not null,
  destination text not null,
  stops text not null default '',
  date date not null,
  time time not null,
  seats smallint not null check (seats between 1 and 8),
  car text not null,
  plate text not null,
  fare integer check (fare is null or fare >= 0),
  notes text not null default '',
  pickup text not null,
  dropoff text not null,
  status text not null default 'scheduled' check (status in ('scheduled','enroute','arrived','started','ended','cancelled')),
  lat double precision check (lat is null or lat between -90 and 90),
  lng double precision check (lng is null or lng between -180 and 180),
  accuracy double precision,
  updated bigint,
  sharing boolean not null default false,
  version integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  ride uuid not null references public.rides(id) on delete cascade,
  passenger uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','approved','declined','cancelled')),
  message text not null default '',
  reply text not null default '',
  created bigint not null default (extract(epoch from now()) * 1000)::bigint,
  unique (ride, passenger)
);

create table if not exists public.shares (
  token text primary key,
  ride uuid not null references public.rides(id) on delete cascade,
  owner uuid not null references public.profiles(id) on delete cascade,
  expires bigint not null
);

create index if not exists idx_rides_date_status on public.rides(date, status);
create index if not exists idx_rides_driver on public.rides(driver);
create index if not exists idx_bookings_passenger on public.bookings(passenger);
create index if not exists idx_shares_ride_owner on public.shares(ride, owner);

create or replace function public.is_ride_passenger(ride_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.bookings b where b.ride = ride_id and b.passenger = auth.uid());
$$;
create or replace function public.is_ride_driver(ride_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.rides r where r.id = ride_id and r.driver = auth.uid());
$$;

alter table public.profiles enable row level security;
alter table public.rides enable row level security;
alter table public.bookings enable row level security;
alter table public.shares enable row level security;

-- Profiles are discoverable for ride cards, but phone is never exposed to other users.
revoke all on public.profiles from anon, authenticated;
grant select (id, name, gender) on public.profiles to anon, authenticated;
grant select (id, name, gender, created_at, updated_at), insert (id, name, gender), update (name, gender, updated_at) on public.profiles to authenticated;
create policy "profiles are visible to verified accounts" on public.profiles for select to authenticated using (auth.uid() is not null);
create policy "users create own profile" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "users update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

revoke all on public.rides from anon, authenticated;
grant select (id, driver, service_city, origin_point, destination_point, origin, destination, stops, date, time, seats, car, fare, notes, pickup, dropoff, status, version, created_at) on public.rides to anon, authenticated;
grant insert, update, delete on public.rides to authenticated;
create policy "scheduled rides are discoverable" on public.rides for select to anon, authenticated using (status = 'scheduled' or driver = auth.uid() or public.is_ride_passenger(id));
create policy "verified users create own rides" on public.rides for insert to authenticated with check (driver = auth.uid());
create policy "drivers update their rides" on public.rides for update to authenticated using (driver = auth.uid()) with check (driver = auth.uid());
create policy "drivers delete their rides" on public.rides for delete to authenticated using (driver = auth.uid());

grant select, insert, update on public.bookings to authenticated;
create policy "booking parties can read bookings" on public.bookings for select to authenticated using (passenger = auth.uid() or public.is_ride_driver(ride));
create policy "users request their own seats" on public.bookings for insert to authenticated with check (passenger = auth.uid() and exists (select 1 from public.rides r where r.id = ride and r.driver <> auth.uid() and r.status = 'scheduled'));
create policy "booking parties update requests" on public.bookings for update to authenticated using (passenger = auth.uid() or public.is_ride_driver(ride)) with check (passenger = auth.uid() or public.is_ride_driver(ride));

revoke all on public.shares from anon, authenticated;
grant select, insert, delete on public.shares to authenticated;
create policy "share owner manages their links" on public.shares for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

-- New verified Auth users receive a minimal profile row; users complete the public fields in the app.
create or replace function public.create_humsafar_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_humsafar on auth.users;
create trigger on_auth_user_created_humsafar after insert on auth.users
for each row execute procedure public.create_humsafar_profile();

create table if not exists public.notification_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_token text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, device_token)
);

alter table public.notification_subscriptions enable row level security;

drop policy if exists "Users can view own notification subscriptions"
on public.notification_subscriptions;

create policy "Users can view own notification subscriptions"
on public.notification_subscriptions
for select
using (auth.uid() = user_id);

drop policy if exists "Users can create own notification subscriptions"
on public.notification_subscriptions;

create policy "Users can create own notification subscriptions"
on public.notification_subscriptions
for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can update own notification subscriptions"
on public.notification_subscriptions;

create policy "Users can update own notification subscriptions"
on public.notification_subscriptions
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete own notification subscriptions"
on public.notification_subscriptions;

create policy "Users can delete own notification subscriptions"
on public.notification_subscriptions
for delete
using (auth.uid() = user_id);


create table if not exists public.notification_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  seat_requests boolean not null default true,
  booking_updates boolean not null default true,
  driver_status boolean not null default true,
  trip_reminders boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notification_settings enable row level security;

drop policy if exists "Users can view own notification settings"
on public.notification_settings;

create policy "Users can view own notification settings"
on public.notification_settings
for select
using (auth.uid() = user_id);

drop policy if exists "Users can create own notification settings"
on public.notification_settings;

create policy "Users can create own notification settings"
on public.notification_settings
for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can update own notification settings"
on public.notification_settings;

create policy "Users can update own notification settings"
on public.notification_settings
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete own notification settings"
on public.notification_settings;

create policy "Users can delete own notification settings"
on public.notification_settings
for delete
using (auth.uid() = user_id);
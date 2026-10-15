-- Private driver-document review. No government database is queried and no
-- automatic document, OCR, or face-match approval is performed.
create table if not exists public.driver_verification_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.driver_verification_admins enable row level security;
revoke all on public.driver_verification_admins from public, anon, authenticated;

create table if not exists public.driver_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  licence_storage_path text,
  selfie_storage_path text,
  vehicle_registration_number text check (vehicle_registration_number is null or vehicle_registration_number ~ '^[A-Z0-9 -]{3,20}$'),
  status text not null default 'pending' check (status in ('pending','approved','rejected','action_required')),
  reviewer_id uuid references auth.users(id) on delete set null,
  review_reason text check (review_reason is null or char_length(review_reason) <= 1000),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  retention_until timestamptz,
  updated_at timestamptz not null default now(),
  check ((licence_storage_path is null) = (selfie_storage_path is null))
);
create index if not exists driver_verifications_status_submitted_idx
  on public.driver_verifications(status, submitted_at);
alter table public.driver_verifications enable row level security;
revoke all on public.driver_verifications from public, anon, authenticated;
grant select on public.driver_verifications to authenticated;

create table if not exists public.driver_verification_review_history (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null references public.driver_verifications(id) on delete cascade,
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  previous_status text not null check (previous_status in ('pending','approved','rejected','action_required')),
  status text not null check (status in ('approved','rejected','action_required')),
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists driver_verification_history_review_idx
  on public.driver_verification_review_history(verification_id, created_at desc);
alter table public.driver_verification_review_history enable row level security;
revoke all on public.driver_verification_review_history from public, anon, authenticated;
grant select on public.driver_verification_review_history to authenticated;

create or replace function public.humsafar_is_driver_verification_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.driver_verification_admins a where a.user_id = auth.uid()
  );
$$;
revoke all on function public.humsafar_is_driver_verification_admin() from public, anon;
grant execute on function public.humsafar_is_driver_verification_admin() to authenticated, anon;

drop policy if exists "drivers and reviewers read verification status" on public.driver_verifications;
create policy "drivers and reviewers read verification status"
  on public.driver_verifications for select to authenticated
  using (user_id = (select auth.uid()) or public.humsafar_is_driver_verification_admin());
drop policy if exists "admins read verification review history" on public.driver_verification_review_history;
create policy "admins read verification review history"
  on public.driver_verification_review_history for select to authenticated
  using (public.humsafar_is_driver_verification_admin());

create or replace function public.humsafar_can_upload_driver_documents(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() = p_user_id and not exists (
    select 1 from public.driver_verifications v
    where v.user_id = p_user_id and v.status not in ('rejected','action_required')
  );
$$;
revoke all on function public.humsafar_can_upload_driver_documents(uuid) from public, anon;
grant execute on function public.humsafar_can_upload_driver_documents(uuid) to authenticated, anon;

create or replace function public.humsafar_can_delete_driver_document(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (storage.foldername(p_name))[1]=auth.uid()::text and not exists (
    select 1 from public.driver_verifications v where v.user_id=auth.uid()
      and p_name in (v.licence_storage_path,v.selfie_storage_path)
  );
$$;
revoke all on function public.humsafar_can_delete_driver_document(text) from public, anon;
grant execute on function public.humsafar_can_delete_driver_document(text) to authenticated, anon;

create or replace function public.humsafar_submit_driver_verification(
  p_licence_path text, p_selfie_path text, p_vehicle_registration_number text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); existing public.driver_verifications;
  old_licence text; old_selfie text;
  registration text := upper(btrim(coalesce(p_vehicle_registration_number,'')));
begin
  if uid is null or not exists(select 1 from auth.users u where u.id=uid and u.email_confirmed_at is not null) then
    raise exception 'Please sign in with a verified account.' using errcode='28000';
  end if;
  if registration !~ '^[A-Z0-9 -]{3,20}$' then raise exception 'Enter a valid vehicle registration number.' using errcode='22023'; end if;
  if p_licence_path is null or p_selfie_path is null
     or split_part(p_licence_path,'/',1) <> uid::text
     or split_part(p_selfie_path,'/',1) <> uid::text
     or p_licence_path !~ ('^' || uid::text || '/[0-9a-f-]{36}/licence\.(jpg|png|webp)$')
     or p_selfie_path !~ ('^' || uid::text || '/[0-9a-f-]{36}/selfie\.(jpg|png|webp)$') then
    raise exception 'Upload valid licence and selfie images.' using errcode='22023';
  end if;
  if not exists(select 1 from storage.objects where bucket_id='driver-verification' and name=p_licence_path)
     or not exists(select 1 from storage.objects where bucket_id='driver-verification' and name=p_selfie_path) then
    raise exception 'Upload both images before submitting.' using errcode='22023';
  end if;
  select * into existing from public.driver_verifications where user_id=uid for update;
  if existing.id is not null then
    if existing.status not in ('rejected','action_required') then
      raise exception 'A verification application is already pending or approved.' using errcode='42501';
    end if;
    old_licence := existing.licence_storage_path;
    old_selfie := existing.selfie_storage_path;
    update public.driver_verifications set licence_storage_path=p_licence_path,
      selfie_storage_path=p_selfie_path, vehicle_registration_number=registration,
      status='pending', reviewer_id=null, review_reason=null, submitted_at=now(),
      reviewed_at=null, retention_until=null, updated_at=now()
      where id=existing.id returning * into existing;
  else
    insert into public.driver_verifications(user_id,licence_storage_path,selfie_storage_path,vehicle_registration_number)
      values(uid,p_licence_path,p_selfie_path,registration) returning * into existing;
  end if;
  return jsonb_build_object('id',existing.id,'status',existing.status,'submitted_at',existing.submitted_at,
    'old_licence_storage_path',old_licence,'old_selfie_storage_path',old_selfie);
end;
$$;
revoke all on function public.humsafar_submit_driver_verification(text,text,text) from public, anon;
grant execute on function public.humsafar_submit_driver_verification(text,text,text) to authenticated;

create or replace function public.humsafar_admin_driver_verifications(p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not public.humsafar_is_driver_verification_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000 then
    raise exception 'Choose a valid page of applications.' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(to_jsonb(page) order by (page.status='pending') desc,page.submitted_at asc),'[]'::jsonb) into result
  from (
    select v.*,coalesce(p.name,'Humsafar user') as driver_name,
      (select coalesce(jsonb_agg(jsonb_build_object('status',h.status,'reason',h.reason,'reviewed_at',h.created_at) order by h.created_at desc),'[]'::jsonb)
        from public.driver_verification_review_history h where h.verification_id=v.id) as history
    from public.driver_verifications v left join public.profiles p on p.id=v.user_id
    order by (v.status='pending') desc,v.submitted_at asc limit p_limit offset p_offset
  ) page;
  return result;
end;
$$;
revoke all on function public.humsafar_admin_driver_verifications(integer,integer) from public, anon;
grant execute on function public.humsafar_admin_driver_verifications(integer,integer) to authenticated;

create or replace function public.humsafar_review_driver_verification(p_id uuid, p_status text, p_reason text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); v public.driver_verifications; reason_value text := nullif(btrim(coalesce(p_reason,'')),'');
begin
  if not public.humsafar_is_driver_verification_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  if p_status not in ('approved','rejected','action_required') then raise exception 'Choose a valid review decision.' using errcode='22023'; end if;
  if p_status in ('rejected','action_required') and (reason_value is null or char_length(reason_value)>1000) then
    raise exception 'Enter a reason for this decision (up to 1000 characters).' using errcode='22023';
  end if;
  select * into v from public.driver_verifications where id=p_id for update;
  if v.id is null then raise exception 'Verification application not found.' using errcode='P0002'; end if;
  if v.status<>'pending' then raise exception 'This application has already been reviewed.' using errcode='22023'; end if;
  insert into public.driver_verification_review_history(verification_id,reviewer_id,previous_status,status,reason)
    values(v.id,uid,v.status,p_status,reason_value);
  update public.driver_verifications set status=p_status, reviewer_id=uid, review_reason=reason_value,
    reviewed_at=now(), retention_until=case when p_status in ('approved','rejected') then now()+interval '90 days' else null end,
    updated_at=now() where id=v.id;
  return jsonb_build_object('ok',true,'status',p_status);
end;
$$;
revoke all on function public.humsafar_review_driver_verification(uuid,text,text) from public, anon;
grant execute on function public.humsafar_review_driver_verification(uuid,text,text) to authenticated;

create or replace function public.humsafar_purge_driver_verification_documents(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.driver_verifications;
begin
  if not public.humsafar_is_driver_verification_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  select * into v from public.driver_verifications where id=p_id for update;
  if v.id is null then raise exception 'Verification application not found.' using errcode='P0002'; end if;
  if v.retention_until is null or v.retention_until>now() or v.status not in ('approved','rejected') then
    raise exception 'Documents can be purged 90 days after an approval or rejection.' using errcode='42501';
  end if;
  update public.driver_verifications set licence_storage_path=null,selfie_storage_path=null,vehicle_registration_number=null,updated_at=now() where id=v.id;
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.humsafar_purge_driver_verification_documents(uuid) from public, anon;
grant execute on function public.humsafar_purge_driver_verification_documents(uuid) to authenticated;

-- Keep the bucket private. Documents are retained through review and for 90
-- days after approval/rejection, then an administrator may purge them from the
-- review page. Action-required documents remain until resubmission/decision.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('driver-verification','driver-verification',false,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "drivers upload their verification documents" on storage.objects;
create policy "drivers upload their verification documents" on storage.objects
  for insert to authenticated with check (
    bucket_id='driver-verification'
    and (storage.foldername(name))[1]=(select auth.uid()::text)
    and public.humsafar_can_upload_driver_documents((select auth.uid()))
  );
drop policy if exists "drivers and admins view verification documents" on storage.objects;
create policy "drivers and admins view verification documents" on storage.objects
  for select to authenticated using (
    bucket_id='driver-verification'
    and ((storage.foldername(name))[1]=(select auth.uid()::text) or public.humsafar_is_driver_verification_admin())
  );
drop policy if exists "admins delete verification documents" on storage.objects;
create policy "admins delete verification documents" on storage.objects
  for delete to authenticated using (
    bucket_id='driver-verification'
    and (public.humsafar_is_driver_verification_admin() or public.humsafar_can_delete_driver_document(name))
  );

-- Restrictive bucket-scoped rules keep any unrelated/global Storage policies
-- from broadening access to these private documents.
drop policy if exists "driver verification documents restrict reads" on storage.objects;
create policy "driver verification documents restrict reads" on storage.objects
  as restrictive for select to public using (
    bucket_id <> 'driver-verification'
    or ((select auth.uid()) is not null and ((storage.foldername(name))[1]=(select auth.uid()::text) or public.humsafar_is_driver_verification_admin()))
  );
drop policy if exists "driver verification documents restrict inserts" on storage.objects;
create policy "driver verification documents restrict inserts" on storage.objects
  as restrictive for insert to public with check (
    bucket_id <> 'driver-verification'
    or ((select auth.uid()) is not null and (storage.foldername(name))[1]=(select auth.uid()::text)
      and public.humsafar_can_upload_driver_documents((select auth.uid())))
  );
drop policy if exists "driver verification documents restrict updates" on storage.objects;
create policy "driver verification documents restrict updates" on storage.objects
  as restrictive for update to public using (bucket_id <> 'driver-verification')
  with check (bucket_id <> 'driver-verification');
drop policy if exists "driver verification documents restrict deletes" on storage.objects;
create policy "driver verification documents restrict deletes" on storage.objects
  as restrictive for delete to public using (
    bucket_id <> 'driver-verification'
    or (public.humsafar_is_driver_verification_admin() or public.humsafar_can_delete_driver_document(name))
  );

-- The first administrator must be granted by the project owner in the SQL
-- editor, using a trusted account UUID from Authentication > Users:
-- insert into public.driver_verification_admins(user_id) values ('<trusted-admin-user-uuid>');

-- The existing create action is a security-definer RPC, so enforce approval
-- here as well as in the UI.
create or replace function public.humsafar_require_verified_driver(p_user_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.driver_verifications v where v.user_id=p_user_id and v.status='approved') then
    raise exception 'Driver verification approval is required before publishing rides.' using errcode='42501';
  end if;
end;
$$;
revoke all on function public.humsafar_require_verified_driver(uuid) from public, anon, authenticated;
create or replace function public.humsafar_check_driver_verified()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.driver is distinct from auth.uid() or not exists(
    select 1 from public.driver_verifications v where v.user_id=new.driver and v.status='approved'
  ) then
    raise exception 'Driver verification approval is required before publishing rides.' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function public.humsafar_check_driver_verified() from public, anon, authenticated;
drop trigger if exists rides_require_driver_verification on public.rides;
create trigger rides_require_driver_verification before insert on public.rides
  for each row execute function public.humsafar_check_driver_verified();


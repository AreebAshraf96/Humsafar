-- Permit replacing one's own pending photos without discarding the request.
-- Submission timestamp + row lock prevent overwriting a concurrent admin review.
drop function if exists public.humsafar_submit_driver_verification(text,text,text);
create or replace function public.humsafar_submit_driver_verification(
  p_licence_path text, p_selfie_path text, p_vehicle_registration_number text, p_expected_submitted_at timestamptz default null
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
  if p_expected_submitted_at is not null and (existing.id is null or existing.status<>'pending' or existing.submitted_at<>p_expected_submitted_at) then
    raise exception 'This request was reviewed or replaced. Refresh before trying again.' using errcode='42501';
  end if;
  if existing.id is not null then
    if existing.status not in ('rejected','action_required') and not (existing.status='approved' and not public.humsafar_driver_approval_valid(uid))
       and not (existing.status='pending' and p_expected_submitted_at is not null and existing.submitted_at=p_expected_submitted_at) then
      raise exception 'A verification application is already pending or approved.' using errcode='42501';
    end if;
    if existing.status='pending' and p_licence_path=existing.licence_storage_path and p_selfie_path=existing.selfie_storage_path then
      raise exception 'Choose at least one new photo.' using errcode='22023';
    end if;
    old_licence := existing.licence_storage_path;
    old_selfie := existing.selfie_storage_path;
    update public.driver_verifications set licence_storage_path=p_licence_path,
      selfie_storage_path=p_selfie_path, vehicle_registration_number=registration,
      licence_expiry_date=null, automated_result='{"state":"unavailable","reasonCode":"checks_pending"}'::jsonb, automated_checked_at=null,
      status='pending', reviewer_id=null, review_reason=null, submitted_at=now(),
      reviewed_at=null, retention_until=null, updated_at=now()
      where id=existing.id returning * into existing;
  else
    insert into public.driver_verifications(user_id,licence_storage_path,selfie_storage_path,vehicle_registration_number)
      values(uid,p_licence_path,p_selfie_path,registration) returning * into existing;
    update public.driver_verifications set automated_result='{"state":"unavailable","reasonCode":"checks_pending"}'::jsonb where id=existing.id;
  end if;
  return jsonb_build_object('id',existing.id,'status',existing.status,'submitted_at',existing.submitted_at,
    'old_licence_storage_path',old_licence,'old_selfie_storage_path',old_selfie);
end;
$$;
revoke all on function public.humsafar_submit_driver_verification(text,text,text,timestamptz) from public,anon;
grant execute on function public.humsafar_submit_driver_verification(text,text,text,timestamptz) to authenticated;
create or replace function public.humsafar_can_upload_driver_documents(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid()=p_user_id and not exists(select 1 from public.driver_verifications v
 where v.user_id=p_user_id and v.status not in ('pending','rejected','action_required')
 and not (v.status='approved' and not public.humsafar_driver_approval_valid(v.user_id)));
$$;
drop function if exists public.humsafar_admin_driver_verifications(integer,integer);
create or replace function public.humsafar_admin_driver_verifications(p_limit integer default 50, p_offset integer default 0, p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not public.humsafar_is_driver_verification_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000 then
    raise exception 'Choose a valid page of applications.' using errcode='22023';
  end if;
  if p_status is not null and p_status not in ('pending','approved','rejected','action_required') then raise exception 'Choose a valid request status.' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(page) order by (page.status='pending') desc,page.submitted_at asc),'[]'::jsonb) into result
  from (
    select v.*,coalesce(p.name,'Humsafar user') as driver_name,
      (select coalesce(jsonb_agg(jsonb_build_object('status',h.status,'reason',h.reason,'reviewed_at',h.created_at) order by h.created_at desc),'[]'::jsonb)
        from public.driver_verification_review_history h where h.verification_id=v.id) as history
    from public.driver_verifications v left join public.profiles p on p.id=v.user_id
    where p_status is null or v.status=p_status
    order by (v.status='pending') desc,v.submitted_at asc limit p_limit offset p_offset
  ) page;
  return result;
end;
$$;
revoke all on function public.humsafar_admin_driver_verifications(integer,integer,text) from public,anon;
grant execute on function public.humsafar_admin_driver_verifications(integer,integer,text) to authenticated;

drop function if exists public.humsafar_review_driver_verification(uuid,text,text,date);
create or replace function public.humsafar_review_driver_verification(p_id uuid, p_status text, p_reason text default '', p_licence_expiry_date date default null, p_expected_submitted_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); v public.driver_verifications; reason_value text:=nullif(btrim(coalesce(p_reason,'')),'');
begin
 if not public.humsafar_is_driver_verification_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
 if p_status is null or p_status not in ('approved','rejected','action_required') then raise exception 'Choose a valid review decision.' using errcode='22023'; end if;
 if char_length(reason_value)>1000 or (p_status in ('rejected','action_required') and reason_value is null) then raise exception 'Enter a reason (up to 1000 characters).' using errcode='22023'; end if;
 select * into v from public.driver_verifications where id=p_id for update;
 if v.id is null then raise exception 'Verification application not found.' using errcode='P0002'; end if;
 if p_expected_submitted_at is not null and v.submitted_at<>p_expected_submitted_at then raise exception 'The applicant replaced their photos. Refresh and inspect the new photos before reviewing.' using errcode='42501'; end if;
 if v.status<>'pending' and not (v.status='approved' and (p_status='action_required' or (p_status='approved' and v.licence_expiry_date is null))) then
   raise exception 'This application has already been reviewed.' using errcode='22023';
 end if;
 if p_status='approved' and (p_licence_expiry_date is null or p_licence_expiry_date<(now() at time zone 'Asia/Karachi')::date) then
   raise exception 'Confirm the licence expiry date before approval.' using errcode='22023';
 end if;
 if p_status='approved' and (v.licence_storage_path is null or v.selfie_storage_path is null) then
   raise exception 'New documents are required before approval.' using errcode='22023';
 end if;
 insert into public.driver_verification_review_history(verification_id,reviewer_id,previous_status,status,reason)
 values(v.id,uid,v.status,p_status,reason_value);
 update public.driver_verifications set status=p_status,reviewer_id=uid,review_reason=reason_value,
   licence_expiry_date=case when p_status='approved' then p_licence_expiry_date else licence_expiry_date end,
   reviewed_at=now(),retention_until=case when p_status in ('approved','rejected') then now()+interval '90 days' else null end,updated_at=now()
 where id=v.id;
 return jsonb_build_object('ok',true,'status',p_status);
end;
$$;
revoke all on function public.humsafar_review_driver_verification(uuid,text,text,date,timestamptz) from public,anon;
grant execute on function public.humsafar_review_driver_verification(uuid,text,text,date,timestamptz) to authenticated;
notify pgrst, 'reload schema';

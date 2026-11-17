-- Release together with the website. Existing approvals without an expiry
-- require administrator confirmation before another ride may be published.
create or replace function public.humsafar_driver_approval_valid(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.driver_verifications v where v.user_id=p_user_id
   and v.status='approved' and v.licence_expiry_date >= (now() at time zone 'Asia/Karachi')::date);
$$;
revoke all on function public.humsafar_driver_approval_valid(uuid) from public,anon,authenticated;

create or replace function public.can_read_ride_chat(p_ride_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null) and exists (
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
  select exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null) and exists (
    select 1 from public.rides r
    where r.id = p_ride_id and r.status in ('scheduled', 'enroute', 'arrived', 'started') and (
      r.driver = auth.uid() or exists (
        select 1 from public.bookings b
        where b.ride = r.id and b.passenger = auth.uid() and b.status = 'approved'
      )
    )
  );
$$;

-- Direct profile lookups exist only to label messages/receipts in a chat
-- the caller can read. Ride cards still obtain profiles through humsafar_api.
create or replace function public.humsafar_chat_profile_visible(p_profile_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null)
 and (p_profile_id=auth.uid()
   or exists(select 1 from public.ride_messages m where m.sender_id=p_profile_id and public.can_read_ride_chat(m.ride_id))
   or exists(select 1 from public.ride_message_reads r where r.reader_id=p_profile_id and public.can_read_ride_chat(r.ride_id)));
$$;
revoke all on function public.humsafar_chat_profile_visible(uuid) from public,anon;
grant execute on function public.humsafar_chat_profile_visible(uuid) to authenticated;
drop policy "profiles are visible to verified accounts" on public.profiles;
create policy "chat participants can resolve profile names" on public.profiles for select to authenticated
 using (public.humsafar_chat_profile_visible(id));

create or replace function public.humsafar_can_upload_driver_documents(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() = p_user_id and not exists (
    select 1 from public.driver_verifications v
    where v.user_id = p_user_id and v.status not in ('rejected','action_required') and not (v.status='approved' and not public.humsafar_driver_approval_valid(v.user_id))
  );
$$;

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
    if existing.status not in ('rejected','action_required') and not (existing.status='approved' and not public.humsafar_driver_approval_valid(uid)) then
      raise exception 'A verification application is already pending or approved.' using errcode='42501';
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

-- Preserve each decision in history; revocation requests new documents.
drop function public.humsafar_review_driver_verification(uuid,text,text);
create function public.humsafar_review_driver_verification(p_id uuid, p_status text, p_reason text default '', p_licence_expiry_date date default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); v public.driver_verifications; reason_value text:=nullif(btrim(coalesce(p_reason,'')),'');
begin
 if not public.humsafar_is_driver_verification_admin() then raise exception 'Administrator access required.' using errcode='42501'; end if;
 if p_status is null or p_status not in ('approved','rejected','action_required') then raise exception 'Choose a valid review decision.' using errcode='22023'; end if;
 if char_length(reason_value)>1000 or (p_status in ('rejected','action_required') and reason_value is null) then raise exception 'Enter a reason (up to 1000 characters).' using errcode='22023'; end if;
 select * into v from public.driver_verifications where id=p_id for update;
 if v.id is null then raise exception 'Verification application not found.' using errcode='P0002'; end if;
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
revoke all on function public.humsafar_review_driver_verification(uuid,text,text,date) from public,anon;
grant execute on function public.humsafar_review_driver_verification(uuid,text,text,date) to authenticated;

create or replace function public.humsafar_check_driver_verified()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.driver is distinct from auth.uid() or not public.humsafar_driver_approval_valid(new.driver) then
   raise exception 'Current driver verification approval is required before publishing rides.' using errcode='42501';
 end if;
 return new;
end;
$$;

create or replace function public.humsafar_api(p_action text, p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 uid uuid := auth.uid(); account auth.users; r public.rides; b public.bookings; prof public.profiles;
 result jsonb; events jsonb := '[]'; item jsonb; origin_p jsonb; destination_p jsonb;
 own boolean; approved boolean; n integer; capacity integer; fare_value integer;
 ride_id uuid; booking_id uuid; day_value date; start_day date; depart time; days jsonb;
 new_status text; reply_value text; phone_value text; token_value text; token_hash text;
 now_ms bigint := (extract(epoch from clock_timestamp())*1000)::bigint;
 today date := (now() at time zone 'Asia/Karachi')::date;
begin
 if uid is null then raise exception 'Please sign in to continue.' using errcode='28000'; end if;
 select * into account from auth.users where id=uid;
 if account.id is null or account.email_confirmed_at is null then raise exception 'Please verify your email before continuing.' using errcode='28000'; end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' or octet_length(p_input::text)>20000 then raise exception 'Invalid request.' using errcode='22023'; end if;
 select * into prof from public.profiles where id=uid;

 if p_action='me' then
   return jsonb_build_object('user',jsonb_build_object('id',uid,'name',coalesce(prof.name,account.email)),
     'profile',case when prof.completed then jsonb_build_object('name',prof.name,'gender',prof.gender,'phone',coalesce((select phone from public.profile_private where id=uid),'')) else null end);
 elsif p_action='profile' then
   phone_value := humsafar_private.text_value(p_input,'phone',14,false);
   if phone_value<>'' and phone_value !~ '^\+92[0-9]{10}$' then raise exception 'Use a Pakistani phone number such as +923001234567.' using errcode='22023'; end if;
   insert into public.profiles(id,name,gender,completed) values(uid,humsafar_private.text_value(p_input,'name',60),humsafar_private.text_value(p_input,'gender',30),true)
   on conflict(id) do update set name=excluded.name,gender=excluded.gender,completed=true,updated_at=now();
   insert into public.profile_private(id,phone) values(uid,phone_value) on conflict(id) do update set phone=excluded.phone;
   update public.rides set version=version+1 where status in ('scheduled','enroute','arrived','started') and (driver=uid or id in (select ride from public.bookings where passenger=uid and status='approved'));
   return '{"ok":true}'::jsonb;
 elsif p_action='rides' then
   day_value := coalesce(nullif(p_input->>'date','')::date,today);
   select coalesce(jsonb_agg(humsafar_private.ride_card(x) order by x.time),'[]') into result
     from public.rides x where x.service_city='Karachi' and x.date=day_value and x.status='scheduled'
     and ((x.date+x.time) at time zone 'Asia/Karachi')>now()
     and (select count(*) from public.bookings y where y.ride=x.id and y.status='approved')<x.seats;
   return jsonb_build_object('rides',result);
 elsif p_action='trips' then
   select coalesce(jsonb_agg(humsafar_private.ride_card(x)||jsonb_build_object('booking',
     (select jsonb_build_object('id',y.id,'status',y.status,'message',y.message,'reply',y.reply) from public.bookings y where y.ride=x.id and y.passenger=uid)) order by x.date desc,x.time desc),'[]') into result
     from public.rides x where x.driver=uid or exists(select 1 from public.bookings y where y.ride=x.id and y.passenger=uid);
   return jsonb_build_object('rides',result);
 elsif p_action='track' then
   token_value := humsafar_private.text_value(p_input,'token',128);
   token_hash := encode(sha256(convert_to(token_value,'UTF8')),'hex');
   select x.* into r from public.shares s join public.rides x on x.id=s.ride where s.token=token_hash and s.expires>now_ms and x.status='started'
     and (x.driver=s.owner or exists(select 1 from public.bookings y where y.ride=x.id and y.passenger=s.owner and y.status='approved'));
   if r.id is null then raise exception 'This shared trip link is unavailable or expired.' using errcode='P0002'; end if;
   return jsonb_build_object('ride',jsonb_build_object('origin',r.origin,'destination',r.destination,'car',r.car,'plate',r.plate,
     'driverName',(select name from public.profiles where id=r.driver),'status',r.status,'lat',r.lat,'lng',r.lng,'accuracy',r.accuracy,'updated',r.updated,'sharing',case when r.sharing then 1 else 0 end));
 elsif p_action='create' then
   if not coalesce(prof.completed,false) then raise exception 'Save your profile first.' using errcode='42501'; end if;
   -- Serializes concurrent recurring offers from the same driver.
   perform 1 from public.profiles where id=uid for update;
   start_day := humsafar_private.text_value(p_input,'date',10)::date;
   if start_day<today or start_day>today+180 then raise exception 'Choose a date within the next six months.' using errcode='22023'; end if;
   if coalesce(p_input->>'time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Choose a valid departure time.' using errcode='22023'; end if;
   depart := (p_input->>'time')::time;
   capacity := (p_input->>'seats')::integer;
   if capacity is null or capacity not between 1 and 8 then raise exception 'Seats must be between 1 and 8.' using errcode='22023'; end if;
   fare_value := (p_input->>'fare')::integer;
   if fare_value is not null and fare_value not between 0 and 100000 then raise exception 'Enter a valid fare in whole rupees.' using errcode='22023'; end if;
   origin_p := humsafar_private.point(p_input->'originPoint'); destination_p := humsafar_private.point(p_input->'destinationPoint');
   if 6371000*2*asin(least(1.0,sqrt(power(sin(radians((destination_p->>'lat')::float8-(origin_p->>'lat')::float8)/2),2)+cos(radians((origin_p->>'lat')::float8))*cos(radians((destination_p->>'lat')::float8))*power(sin(radians((destination_p->>'lng')::float8-(origin_p->>'lng')::float8)/2),2))))<50 then raise exception 'Choose pickup and drop-off points at least 50 metres apart.' using errcode='22023'; end if;
   days := coalesce(p_input->'days','[]');
   if jsonb_typeof(days)<>'array' then raise exception 'Invalid repeat days.' using errcode='22023'; end if;
   if exists(select 1 from jsonb_array_elements(days) d where d::text !~ '^[0-6]$') then raise exception 'Invalid repeat days.' using errcode='22023'; end if;
   n:=0;
   for day_value in select start_day+i from generate_series(0,case when jsonb_array_length(days)=0 then 0 else 27 end) i loop
     if (jsonb_array_length(days)=0 or days @> to_jsonb(array[extract(dow from day_value)::integer])) and ((day_value+depart) at time zone 'Asia/Karachi')>now() then
       insert into public.rides(driver,service_city,origin_point,destination_point,origin,destination,stops,date,time,seats,car,plate,fare,notes,pickup,dropoff)
       values(uid,'Karachi',origin_p,destination_p,origin_p->>'label',destination_p->>'label',humsafar_private.text_value(p_input,'stops',600,false),day_value,depart,capacity,
         humsafar_private.text_value(p_input,'car',100),humsafar_private.text_value(p_input,'plate',30),fare_value,humsafar_private.text_value(p_input,'notes',600,false),humsafar_private.text_value(p_input,'pickup',250),humsafar_private.text_value(p_input,'dropoff',250));
       n:=n+1;
     end if;
   end loop;
   if n=0 then raise exception 'Departure must be in the future.' using errcode='22023'; end if;
   if (select count(*) from public.rides where driver=uid and date>=today and status in ('scheduled','enroute','arrived','started'))>100 then raise exception 'You can have at most 100 upcoming departures.' using errcode='22023'; end if;
   return jsonb_build_object('ok',true,'count',n);
 end if;

 ride_id := (p_input->>'id')::uuid;
 -- Every booking, capacity and lifecycle mutation shares this row lock.
 select * into r from public.rides where id=ride_id for update;
 if r.id is null then raise exception 'Ride not found.' using errcode='P0002'; end if;
 own := r.driver=uid;
 select * into b from public.bookings where ride=r.id and passenger=uid;
 approved := coalesce(b.status='approved',false);
 if p_action='detail' then
   result:=humsafar_private.ride_card(r);
   if own or approved then result:=result||jsonb_build_object('plate',r.plate,'phone',coalesce((select phone from public.profile_private where id=r.driver),''),
     'lat',r.lat,'lng',r.lng,'accuracy',r.accuracy,'updated',r.updated,'sharing',case when r.sharing then 1 else 0 end); end if;
   select coalesce(jsonb_agg(jsonb_build_object('id',y.id,'status',y.status,'message',y.message,'reply',y.reply,'name',p.name,'gender',p.gender,'phone',coalesce(v.phone,'')) order by y.created),'[]') into item
     from public.bookings y join public.profiles p on p.id=y.passenger left join public.profile_private v on v.id=p.id
     where own and y.ride=r.id and y.status in ('pending','approved');
   return jsonb_build_object('ride',result,'own',own,'booking',case when b.id is null then null else jsonb_build_object('id',b.id,'status',b.status,'message',b.message,'reply',b.reply) end,'passengers',humsafar_private.manifest(r.id),'requests',item);
 end if;
 if not coalesce(prof.completed,false) then raise exception 'Save your profile first.' using errcode='42501'; end if;
 if p_action in ('seats','approve','decline','status','location') and not own then raise exception 'Only the driver can do that.' using errcode='42501'; end if;
 if p_action='request' then
   if own then raise exception 'You cannot request your own ride.' using errcode='22023'; end if;
   if r.status<>'scheduled' or ((r.date+r.time) at time zone 'Asia/Karachi')<=now() or (select count(*) from public.bookings where ride=r.id and status='approved')>=r.seats then raise exception 'This ride is no longer accepting requests.' using errcode='22023'; end if;
   if b.status in ('pending','approved') then raise exception 'You already have a request for this ride.' using errcode='22023'; end if;
   insert into public.bookings(ride,passenger,message) values(r.id,uid,humsafar_private.text_value(p_input,'message',600,false))
   on conflict(ride,passenger) do update set status='pending',message=excluded.message,reply='',created=now_ms;
   events:=jsonb_build_array(jsonb_build_object('userId',r.driver,'title','New seat request','body',prof.name||' requested a seat for '||r.origin||' → '||r.destination,'category','seat_requests'));
 elsif p_action='cancelBooking' then
   if b.id is null or b.status not in ('pending','approved') or r.status not in ('scheduled','enroute','arrived') then raise exception 'This booking cannot be cancelled now.' using errcode='22023'; end if;
   update public.bookings set status='cancelled' where id=b.id;
   delete from public.shares where ride=r.id and owner=uid;
   events:=jsonb_build_array(jsonb_build_object('userId',r.driver,'title','Seat cancelled','body',prof.name||' cancelled their seat.','category','booking_updates'));
 elsif p_action='seats' then
   capacity:=(p_input->>'seats')::integer;
   if capacity is null or capacity not between 1 and 8 or capacity<(select count(*) from public.bookings where ride=r.id and status='approved') or r.status not in ('scheduled','enroute','arrived') then raise exception 'Seat capacity cannot be below approved bookings or changed after the trip starts.' using errcode='22023'; end if;
   update public.rides set seats=capacity where id=r.id;
 elsif p_action in ('approve','decline') then
   booking_id:=(p_input->>'bookingId')::uuid;
   select * into b from public.bookings where id=booking_id and ride=r.id and status='pending';
   if b.id is null or r.status not in ('scheduled','enroute','arrived') then raise exception 'The request or trip has already changed.' using errcode='22023'; end if;
   if p_action='approve' and (select count(*) from public.bookings where ride=r.id and status='approved')>=r.seats then raise exception 'No seat available.' using errcode='22023'; end if;
   new_status:=case when p_action='approve' then 'approved' else 'declined' end;
   update public.bookings set status=new_status,reply=humsafar_private.text_value(p_input,'reply',600,false) where id=b.id;
   events:=jsonb_build_array(jsonb_build_object('userId',b.passenger,'title','Seat '||new_status,'body','Your seat for '||r.origin||' → '||r.destination||' was '||new_status||'.','category','booking_updates'));
 elsif p_action='status' then
   new_status:=p_input->>'status';
   if new_status is null or not ((r.status='scheduled' and new_status in ('enroute','cancelled')) or (r.status='enroute' and new_status in ('arrived','cancelled')) or (r.status='arrived' and new_status in ('started','cancelled')) or (r.status='started' and new_status='ended')) then raise exception 'This trip status cannot be changed that way.' using errcode='22023'; end if;
   update public.rides set status=new_status where id=r.id;
   if new_status in ('ended','cancelled') then
     update public.rides set lat=null,lng=null,accuracy=null,updated=null,sharing=false where id=r.id;
     delete from public.shares where ride=r.id;
   end if;
   select coalesce(jsonb_agg(jsonb_build_object('userId',passenger,'title','Trip update','body',r.origin||' → '||r.destination||': '||case new_status when 'enroute' then 'Driver on the way' when 'arrived' then 'Driver has arrived' when 'started' then 'Trip started' when 'ended' then 'Trip completed' else 'Trip cancelled' end,'category','driver_status')),'[]') into events
     from public.bookings where ride=r.id and (status='approved' or (new_status='cancelled' and status='pending'));
 elsif p_action='location' then
   if r.status not in ('enroute','arrived','started') then raise exception 'Location sharing is unavailable at this trip stage.' using errcode='22023'; end if;
   if coalesce(p_input->>'stop','false')='true' then
     update public.rides set lat=null,lng=null,accuracy=null,updated=null,sharing=false where id=r.id;
   else
     if jsonb_typeof(p_input->'lat') is distinct from 'number' or jsonb_typeof(p_input->'lng') is distinct from 'number' or jsonb_typeof(p_input->'accuracy') is distinct from 'number'
       or not ((p_input->>'lat')::float8 between -90 and 90 and (p_input->>'lng')::float8 between -180 and 180 and (p_input->>'accuracy')::float8 between 0 and 100000) then raise exception 'Invalid location.' using errcode='22023'; end if;
     update public.rides set lat=(p_input->>'lat')::float8,lng=(p_input->>'lng')::float8,accuracy=(p_input->>'accuracy')::float8,updated=now_ms,sharing=true where id=r.id;
   end if;
 elsif p_action in ('share','revokeShare') then
   if not own and not approved then raise exception 'Only approved travellers may share this trip.' using errcode='42501'; end if;
   if p_action='share' and r.status<>'started' then raise exception 'Sharing is available after the trip starts.' using errcode='22023'; end if;
   delete from public.shares where ride=r.id and owner=uid;
   if p_action='share' then
     token_value:=gen_random_uuid()::text||gen_random_uuid()::text;
     insert into public.shares(token,ride,owner,expires) values(encode(sha256(convert_to(token_value,'UTF8')),'hex'),r.id,uid,now_ms+43200000);
     return jsonb_build_object('token',token_value);
   end if;
 else raise exception 'Unknown action.' using errcode='22023';
 end if;
 update public.rides set version=version+1 where id=r.id;
 return jsonb_build_object('ok',true,'_notifications',events);
end $$;

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
  update public.driver_verifications set
    licence_storage_path=null, selfie_storage_path=null, vehicle_registration_number=null,
    automated_result='{"state":"purged"}'::jsonb,
    automated_checked_at=null, updated_at=now()
  where id=v.id;
  return jsonb_build_object('ok',true);
end;
$$;

create or replace function public.humsafar_require_verified_driver(p_user_id uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
 if not public.humsafar_driver_approval_valid(p_user_id) then
  raise exception 'Current driver verification approval is required before publishing rides.' using errcode='42501';
 end if;
end;
$$;

create index if not exists ride_messages_cursor_idx on public.ride_messages(ride_id,created_at desc,id desc);

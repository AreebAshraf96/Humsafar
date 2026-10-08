-- All ride access goes through this verified, transactional API. No service key
-- is needed by the website. Existing application rows are preserved.
create schema if not exists humsafar_private;
revoke all on schema humsafar_private from public, anon, authenticated;
alter table public.profiles add column if not exists completed boolean not null default false;
update public.profiles set completed = true where exists (select 1 from public.profile_private p where p.id = profiles.id);

-- Table revocation alone does not revoke the earlier column-level grants.
do $$ declare t text; cols text; begin
  foreach t in array array['profiles','profile_private','rides','bookings','shares'] loop
    execute format('revoke all on public.%I from anon, authenticated', t);
    select string_agg(quote_ident(column_name), ',') into cols from information_schema.columns where table_schema='public' and table_name=t;
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on public.%I from anon, authenticated', cols,cols,cols,cols,t);
  end loop;
end $$;
revoke execute on function public.is_ride_passenger(uuid), public.is_ride_driver(uuid), public.create_humsafar_profile() from public, anon, authenticated;

create or replace function humsafar_private.text_value(p jsonb, k text, maximum integer, required boolean default true)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p->>k,'')); begin
 if (p ? k and jsonb_typeof(p->k) <> 'string') or length(v)>maximum or (required and v='') then
   raise exception 'Please complete % with a valid value.', k using errcode='22023';
 end if;
 return v;
end $$;

create or replace function humsafar_private.point(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
begin
 if p is null or jsonb_typeof(p)<>'object' or jsonb_typeof(p->'lat') is distinct from 'number' or jsonb_typeof(p->'lng') is distinct from 'number'
   or not ((p->>'lat')::float8 between 24.70 and 25.25 and (p->>'lng')::float8 between 66.75 and 67.60)
   or coalesce(p->>'source','') not in ('pin','photon') then
   raise exception 'Choose and confirm a location inside the Karachi pilot area.' using errcode='22023';
 end if;
 perform humsafar_private.text_value(p,'id',140);
 perform humsafar_private.text_value(p,'label',160);
 perform humsafar_private.text_value(p,'address',250,false);
 return p;
end $$;

create or replace function humsafar_private.ride_card(r public.rides)
returns jsonb language sql stable set search_path = '' as $$
 select (to_jsonb(r) - array['plate','lat','lng','accuracy','updated','sharing']) || jsonb_build_object(
   'time',to_char(r.time,'HH24:MI'), 'origin_point', r.origin_point::text,'destination_point',r.destination_point::text,
   'driverName',p.name,'driverGender',p.gender,
   'occupied',(select count(*) from public.bookings b where b.ride=r.id and b.status='approved'))
 from public.profiles p where p.id=r.driver;
$$;

create or replace function humsafar_private.manifest(ride_id uuid)
returns jsonb language sql stable set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('name',p.name,'gender',p.gender) order by b.created),'[]'::jsonb)
 from public.bookings b join public.profiles p on p.id=b.passenger where b.ride=ride_id and b.status='approved';
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
   if (select count(*) from public.rides where driver=uid and date>=today)>100 then raise exception 'You can have at most 100 upcoming departures.' using errcode='22023'; end if;
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

revoke all on all functions in schema humsafar_private from public,anon,authenticated;
revoke all on function public.humsafar_api(text,jsonb) from public,anon;
grant execute on function public.humsafar_api(text,jsonb) to authenticated;

-- A device belongs to its currently signed-in account. Ownership transfer is
-- only possible for someone holding that device's unguessable FCM token.
delete from public.notification_subscriptions a using public.notification_subscriptions b where a.device_token=b.device_token and (a.updated_at,a.id)<(b.updated_at,b.id);
create unique index if not exists notification_device_unique on public.notification_subscriptions(device_token);
revoke all on public.notification_subscriptions from anon,authenticated;
create or replace function public.humsafar_device(p_token text,p_enabled boolean)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); begin
 if uid is null or not exists(select 1 from auth.users where id=uid and email_confirmed_at is not null) then raise exception 'Please sign in.' using errcode='28000'; end if;
 if p_token is null or length(p_token)<20 or length(p_token)>4096 or p_enabled is null then raise exception 'Invalid device token.' using errcode='22023'; end if;
 if p_enabled then
   insert into public.notification_subscriptions(user_id,device_token,enabled) values(uid,p_token,true)
   on conflict(device_token) do update set user_id=excluded.user_id,enabled=true,updated_at=now();
 else
   delete from public.notification_subscriptions where device_token=p_token and user_id=uid;
 end if;
end $$;
revoke all on function public.humsafar_device(text,boolean) from public,anon;
grant execute on function public.humsafar_device(text,boolean) to authenticated;

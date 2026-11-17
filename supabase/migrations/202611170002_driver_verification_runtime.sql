-- Keep a dedicated current-approval guard even if an older review migration
-- replaces the original rides_require_driver_verification trigger function.
create or replace function public.humsafar_check_current_driver_approval()
returns trigger language plpgsql security definer set search_path='' as $$
declare approval public.driver_verifications;
begin
 if new.driver is distinct from auth.uid() then
  raise exception 'Only the signed-in driver may publish a ride.' using errcode='42501';
 end if;
 select * into approval from public.driver_verifications where user_id=new.driver for share;
 if approval.id is null or approval.status<>'approved' or approval.licence_expiry_date is null
   or approval.licence_expiry_date<(now() at time zone 'Asia/Karachi')::date then
  raise exception 'Current driver verification approval is required before publishing rides.' using errcode='42501';
 end if;
 return new;
end;
$$;
revoke all on function public.humsafar_check_current_driver_approval() from public,anon,authenticated;
do $$ begin
 if not exists(select 1 from pg_trigger where tgrelid='public.rides'::regclass and tgname='rides_require_current_driver_approval') then
  create trigger rides_require_current_driver_approval before insert on public.rides
   for each row execute function public.humsafar_check_current_driver_approval();
 end if;
end $$;

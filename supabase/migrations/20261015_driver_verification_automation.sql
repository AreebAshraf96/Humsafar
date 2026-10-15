-- Persist only the result fields needed for transparent review. Never store
-- face embeddings or OCR text extracted from the identity document.
alter table public.driver_verifications
  add column if not exists licence_expiry_date date,
  add column if not exists automated_result jsonb not null default '{"state":"not_run"}'::jsonb,
  add column if not exists automated_checked_at timestamptz;

comment on column public.driver_verifications.automated_result is
  'Minimal self-hosted OCR/face-check result; contains no image bytes, OCR transcript, or face embedding.';

-- Remove biometric comparison scores and extracted expiry data when the
-- associated documents reach the existing 90-day purge point.
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
    licence_expiry_date=null, automated_result='{"state":"purged"}'::jsonb,
    automated_checked_at=null, updated_at=now()
  where id=v.id;
  return jsonb_build_object('ok',true);
end;
$$;

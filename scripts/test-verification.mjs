import assert from 'node:assert/strict';
import { createTestDatabase } from './testing/database.mjs';

const { db, asUser } = await createTestDatabase();
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const denied = async (fn, code) => { await assert.rejects(fn, error => { assert.equal(error.code, code, error.message); return true; }); checks++; };
const driver = '00000000-0000-4000-8000-000000000011';
const stranger = '00000000-0000-4000-8000-000000000012';
const admin = '00000000-0000-4000-8000-000000000013';
const first = `${driver}/11111111-1111-4111-8111-111111111111`;
const second = `${driver}/22222222-2222-4222-8222-222222222222`;
try {
  for (const [id, name] of [[driver, 'Driver'], [stranger, 'Stranger'], [admin, 'Reviewer']]) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)', [id, `${name.toLowerCase()}@example.test`, new Date().toISOString()]);
  }
  await asUser(driver, `insert into storage.objects(bucket_id,name) values
    ('driver-verification',$1),('driver-verification',$2)`, [`${first}/licence.jpg`, `${first}/selfie.jpg`]);
  const submission = await asUser(driver, `select public.humsafar_submit_driver_verification($1,$2,$3) as value`,
    [`${first}/licence.jpg`, `${first}/selfie.jpg`, 'ABC-123']);
  check(submission.rows[0].value.status === 'pending', 'submission begins pending');
  check((await asUser(stranger, 'select id from public.driver_verifications where user_id=$1', [driver])).rows.length === 0, 'other drivers cannot read application');
  check((await asUser(stranger, 'select name from storage.objects where name=$1', [`${first}/licence.jpg`])).rows.length === 0, 'other users cannot read private files');
  await denied(() => asUser(stranger, "insert into storage.objects(bucket_id,name) values('driver-verification',$1)", [`${first}/forged.jpg`]), '42501');
  await denied(() => asUser(driver, "update public.driver_verifications set status='approved' where user_id=$1", [driver]), '42501');
  await denied(() => asUser(driver, "insert into public.driver_verifications(user_id,vehicle_registration_number,status) values($1,'XYZ-123','approved')", [driver]), '42501');
  await denied(() => asUser(driver, 'select public.humsafar_submit_driver_verification($1,$2,$3)', [`${first}/licence.jpg`, `${first}/selfie.jpg`, 'ABC-123']), '42501');

  await db.query('insert into public.driver_verification_admins(user_id) values($1)', [admin]);
  const required = await asUser(admin, 'select public.humsafar_review_driver_verification($1,$2,$3) as value', [submission.rows[0].value.id, 'action_required', 'Please upload a clearer licence photo.']);
  check(required.rows[0].value.status === 'action_required', 'authorized reviewer may request more information');
  await asUser(driver, `insert into storage.objects(bucket_id,name) values
    ('driver-verification',$1),('driver-verification',$2)`, [`${second}/licence.png`, `${second}/selfie.png`]);
  const resubmitted = await asUser(driver, 'select public.humsafar_submit_driver_verification($1,$2,$3) as value',
    [`${second}/licence.png`, `${second}/selfie.png`, 'XYZ-456']);
  check(resubmitted.rows[0].value.status === 'pending' && resubmitted.rows[0].value.old_licence_storage_path === `${first}/licence.jpg`, 'action-required application can resubmit and returns old paths for cleanup');
  await asUser(driver, "delete from storage.objects where bucket_id='driver-verification' and name=$1", [`${first}/licence.jpg`]);
  const protectedCurrentFile = await asUser(driver, "delete from storage.objects where bucket_id='driver-verification' and name=$1", [`${second}/licence.png`]);
  check(protectedCurrentFile.rowCount === 0, 'drivers cannot delete documents attached to an active submission');
  const approved = await asUser(admin, 'select public.humsafar_review_driver_verification($1,$2,$3) as value', [submission.rows[0].value.id, 'approved', '']);
  check(approved.rows[0].value.status === 'approved', 'administrator can approve a resubmission');
  check((await asUser(admin, 'select public.humsafar_admin_driver_verifications() as value')).rows[0].value.length === 1, 'admin review queue includes application history');
  await denied(() => asUser(admin, 'select public.humsafar_purge_driver_verification_documents($1)', [submission.rows[0].value.id]), '42501');
  await db.query("update public.driver_verifications set retention_until=now()-interval '1 second' where id=$1", [submission.rows[0].value.id]);
  await asUser(admin, "delete from storage.objects where bucket_id='driver-verification' and name=any($1::text[])", [[`${second}/licence.png`, `${second}/selfie.png`]]);
  await asUser(admin, 'select public.humsafar_purge_driver_verification_documents($1)', [submission.rows[0].value.id]);
  check((await db.query('select licence_storage_path,selfie_storage_path,vehicle_registration_number from public.driver_verifications where id=$1', [submission.rows[0].value.id])).rows[0].licence_storage_path === null, 'retention purge clears private document references and registration');
  console.log(`${checks} driver verification checks passed: secure uploads, private access, protected status, resubmission, admin review history, and retention purge.`);
} finally { await db.close(); }

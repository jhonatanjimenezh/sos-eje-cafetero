import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

const db = new Client({ connectionString: DATABASE_URL });
await db.connect();

async function expectConstraintViolation(savepoint, expectedCode, operation, failureMessage) {
  if (!/^[a-z0-9_]+$/i.test(savepoint)) throw new Error('unsafe savepoint name');
  await db.query(`SAVEPOINT ${savepoint}`);
  let rejected = false;
  try {
    await operation();
  } catch (error) {
    rejected = error?.code === expectedCode;
    if (!rejected) {
      await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await db.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
  await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await db.query(`RELEASE SAVEPOINT ${savepoint}`);
  if (!rejected) throw new Error(failureMessage);
}

try {
  await db.query('BEGIN');

  const tables = await db.query(`
    SELECT table_name,column_name
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name IN (
        'pet_profiles','pet_cases','pet_case_media','pet_claims','pet_claim_challenges',
        'pet_claim_evidence','pet_claim_actions','pet_blocks'
      )
    ORDER BY table_name,column_name
  `);
  const byTable = new Map();
  for (const row of tables.rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
    byTable.get(row.table_name).add(row.column_name);
  }
  for (const required of [
    'pet_profiles','pet_cases','pet_case_media','pet_claims','pet_claim_challenges',
    'pet_claim_evidence','pet_claim_actions','pet_blocks',
  ]) {
    if (!byTable.has(required)) throw new Error(`missing table ${required}`);
  }

  const profileColumns = byTable.get('pet_profiles');
  for (const required of ['private_payload_ciphertext','private_payload_iv','private_payload_tag','owner_document_hash','microchip_hash']) {
    if (!profileColumns.has(required)) throw new Error(`missing pet_profiles.${required}`);
  }
  for (const forbidden of ['owner_phone','phone_e164','owner_address','owner_document_number','private_distinguishing_marks']) {
    if (profileColumns.has(forbidden)) throw new Error(`plaintext pet owner field forbidden: ${forbidden}`);
  }

  const mediaColumns = byTable.get('pet_case_media');
  for (const required of ['moderation_status','moderated_by_official_id','moderated_at']) {
    if (!mediaColumns.has(required)) throw new Error(`missing pet_case_media.${required}`);
  }

  for (const table of ['pet_cases','pet_claims','pet_claim_evidence']) {
    const columns = byTable.get(table);
    for (const forbidden of ['phone','phone_e164','owner_phone','finder_phone']) {
      if (columns.has(forbidden)) throw new Error(`${table}.${forbidden} must not exist`);
    }
  }

  const viewColumns = await db.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='public_pet_cases'
    ORDER BY ordinal_position
  `);
  const actualPublic = viewColumns.rows.map(row => row.column_name);
  const expectedPublic = ['public_id','kind','public_name'];
  if (JSON.stringify(actualPublic) !== JSON.stringify(expectedPublic)) {
    throw new Error(`public_pet_cases exposes unexpected columns: ${actualPublic.join(',')}`);
  }

  const owner = `pet-owner-${crypto.randomUUID()}`;
  const finder = `pet-finder-${crypto.randomUUID()}`;
  await db.query(`INSERT INTO auth_identities(subject,phone_e164) VALUES($1,$2),($3,$4)`, [
    owner, '+573001110001', finder, '+573001110002',
  ]);

  const profile = await db.query(`INSERT INTO pet_profiles(
    owner_auth_subject,pet_name,animal_type,sex,microchip_hash,microchip_last4,
    private_payload_ciphertext,private_payload_iv,private_payload_tag,consent_version)
    VALUES($1,'Synthetic Pet','DOG','UNKNOWN','synthetic-hmac','0001',$2,$3,$4,'test-v1')
    RETURNING id`, [owner, Buffer.from('ciphertext'), crypto.getRandomValues(new Uint8Array(12)), crypto.getRandomValues(new Uint8Array(16))]);

  await expectConstraintViolation(
    'lost_without_profile',
    '23514',
    () => db.query(`INSERT INTO pet_cases(created_by_subject,kind,animal_type,public_name)
      VALUES($1,'LOST','DOG','Synthetic')`, [owner]),
    'LOST case without private pet profile was not rejected',
  );

  const lost = await db.query(`INSERT INTO pet_cases(pet_profile_id,created_by_subject,kind,animal_type,public_name,exact_location)
    VALUES($1,$2,'LOST','DOG','Synthetic Pet',ST_SetSRID(ST_MakePoint(-75.52,5.06),4326)::geography)
    RETURNING id,public_id`, [profile.rows[0].id, owner]);

  const found = await db.query(`INSERT INTO pet_cases(created_by_subject,kind,animal_type,public_name,exact_location)
    VALUES($1,'FOUND','DOG','Sin identificar',ST_SetSRID(ST_MakePoint(-75.51,5.07),4326)::geography)
    RETURNING id`, [finder]);
  if (!found.rowCount) throw new Error('FOUND case without prior LOST/profile should be allowed');

  const media = await db.query(`INSERT INTO pet_case_media(
    case_id,object_key,content_type,declared_sha256,declared_size_bytes,actual_sha256,actual_size_bytes,upload_status,scan_status,completed_at)
    VALUES($1,$2,'image/jpeg',$3,128,$3,128,'READY','NO_THREATS_FOUND',now())
    RETURNING id,moderation_status`, [lost.rows[0].id, `private/pets/test/${crypto.randomUUID()}.jpg`, '0'.repeat(64)]);
  if (media.rows[0].moderation_status !== 'PENDING') throw new Error('catalog photo must start moderation PENDING');

  await expectConstraintViolation(
    'approve_without_official',
    '23514',
    () => db.query(`UPDATE pet_case_media SET moderation_status='APPROVED' WHERE id=$1`, [media.rows[0].id]),
    'catalog photo became APPROVED without moderator identity/timestamp',
  );

  const claim = await db.query(`INSERT INTO pet_claims(case_id,claimant_subject,claimant_role,status)
    VALUES($1,$2,'FINDER','EVIDENCE_READY') RETURNING id,public_id,status`, [lost.rows[0].id, finder]);
  await db.query(`INSERT INTO pet_claim_actions(claim_id,actor_subject,action)
    VALUES($1,$2,'OWNER_REJECT')`, [claim.rows[0].id, owner]);

  const afterAction = await db.query('SELECT public_id,status FROM pet_claims WHERE id=$1', [claim.rows[0].id]);
  if (afterAction.rows[0].status !== 'EVIDENCE_READY') throw new Error('private owner action changed claimant-visible lifecycle');
  if (afterAction.rows[0].public_id !== claim.rows[0].public_id) throw new Error('private owner action changed claim public id');

  await expectConstraintViolation(
    'private_claim_status',
    '23514',
    () => db.query("UPDATE pet_claims SET status='BLOCKED_BY_OWNER' WHERE id=$1", [claim.rows[0].id]),
    'pet_claims allows private target-action status',
  );

  const publicRow = await db.query('SELECT row_to_json(v)::text row_text FROM public_pet_cases v WHERE public_id=$1', [lost.rows[0].public_id]);
  const serialized = String(publicRow.rows[0].row_text);
  for (const forbidden of ['+573001110001', '-75.52', '5.06', 'synthetic-hmac', 'OPEN', 'MATCH_REVIEW']) {
    if (serialized.includes(forbidden)) throw new Error(`public projection leaked sensitive or operational value: ${forbidden}`);
  }

  await db.query('ROLLBACK');
  console.log('pet safety DB invariants passed: private owner data, minimal public view, no match-status oracle, moderated photos, FOUND without prior report, stable claim lifecycle');
} catch (error) {
  try { await db.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  await db.end();
}

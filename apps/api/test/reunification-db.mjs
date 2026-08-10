import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

const db = new Client({ connectionString: DATABASE_URL });
await db.connect();

try {
  const columns = await db.query(`
    SELECT table_name,column_name,is_nullable
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name IN ('reunification_requests','reunification_target_actions','reunification_blocks')
    ORDER BY table_name,column_name
  `);

  const byTable = new Map();
  for (const row of columns.rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
    byTable.get(row.table_name).push(row.column_name);
  }

  for (const required of ['reunification_requests','reunification_target_actions','reunification_blocks']) {
    if (!byTable.has(required)) throw new Error(`missing table ${required}`);
  }

  const requestColumns = new Set(byTable.get('reunification_requests'));
  for (const required of ['seeker_auth_subject','target_lookup_token','lookup_key_version','status','expires_at']) {
    if (!requestColumns.has(required)) throw new Error(`missing reunification_requests.${required}`);
  }
  for (const forbidden of ['target_phone','target_phone_e164','searched_phone','searched_phone_e164']) {
    if (requestColumns.has(forbidden)) throw new Error(`plaintext target-phone column forbidden: ${forbidden}`);
  }

  const nullability = new Map(columns.rows
    .filter(row => row.table_name === 'reunification_requests')
    .map(row => [row.column_name, row.is_nullable]));
  if (nullability.get('target_lookup_token') !== 'NO') throw new Error('target_lookup_token must be NOT NULL');
  if (nullability.get('lookup_key_version') !== 'NO') throw new Error('lookup_key_version must be NOT NULL');

  const indexes = await db.query(`
    SELECT indexname,indexdef
    FROM pg_indexes
    WHERE schemaname='public' AND tablename='reunification_requests'
  `);
  const indexText = indexes.rows.map(row => `${row.indexname} ${row.indexdef}`).join('\n');
  if (!/reunification_requests_target_idx/.test(indexText)) throw new Error('target lookup index missing');
  if (!/reunification_requests_active_pair_uq/.test(indexText) || !/UNIQUE/.test(indexText)) {
    throw new Error('active seeker-target uniqueness invariant missing');
  }

  const authA = `test-seeker-${crypto.randomUUID()}`;
  const authB = `test-target-${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO auth_identities(subject,phone_e164) VALUES($1,$2),($3,$4)`,
    [authA, '+573000000001', authB, '+573000000002'],
  );

  const token = crypto.randomUUID().replaceAll('-', '');
  const inserted = await db.query(`
    INSERT INTO reunification_requests(
      seeker_auth_subject,target_lookup_token,lookup_key_version,seeker_display_name,
      declared_relationship,message,share_seeker_phone,status,expires_at
    ) VALUES($1,$2,1,'Synthetic seeker','FAMILIAR','Synthetic private message',true,'ACTIVE',now()+interval '1 day')
    RETURNING id,public_id
  `, [authA, token]);

  let duplicateRejected = false;
  try {
    await db.query(`
      INSERT INTO reunification_requests(
        seeker_auth_subject,target_lookup_token,lookup_key_version,share_seeker_phone,status,expires_at
      ) VALUES($1,$2,1,true,'ACTIVE',now()+interval '1 day')
    `, [authA, token]);
  } catch (error) {
    duplicateRejected = error?.code === '23505';
  }
  if (!duplicateRejected) throw new Error('duplicate active seeker-target request was not rejected');

  await db.query(`
    INSERT INTO reunification_target_actions(request_id,target_auth_subject,action)
    VALUES($1,$2,'REVEAL_CONTACT'),($1,$2,'REPORT_ABUSE')
  `, [inserted.rows[0].id, authB]);
  await db.query(`
    INSERT INTO reunification_blocks(target_auth_subject,seeker_auth_subject)
    VALUES($1,$2)
  `, [authB, authA]);

  // Una acción privada del target no puede modificar el lifecycle observable por seeker.
  const lifecycle = await db.query(
    'SELECT status,public_id FROM reunification_requests WHERE id=$1',
    [inserted.rows[0].id],
  );
  if (lifecycle.rows[0].status !== 'ACTIVE') throw new Error('target-private action changed seeker-visible lifecycle');
  if (lifecycle.rows[0].public_id !== inserted.rows[0].public_id) throw new Error('target-private action changed request public id');

  let privateStatusRejected = false;
  try {
    await db.query("UPDATE reunification_requests SET status='ABUSE_REVIEW' WHERE id=$1", [inserted.rows[0].id]);
  } catch (error) {
    privateStatusRejected = error?.code === '23514';
  }
  if (!privateStatusRejected) throw new Error('request status constraint allows target-private state');

  const leaked = await db.query(`
    SELECT row_to_json(r)::text AS row_text
    FROM reunification_requests r WHERE id=$1
  `, [inserted.rows[0].id]);
  const serialized = String(leaked.rows[0].row_text);
  if (serialized.includes('+573000000002')) throw new Error('target phone leaked into reunification request row');

  await db.query('DELETE FROM auth_identities WHERE subject IN ($1,$2)', [authA, authB]);
  console.log('reunification DB invariants passed: blind token, no target phone, stable lifecycle, actions and block');
} finally {
  await db.end();
}

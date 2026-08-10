import pg from 'pg';
const { Client } = pg;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query('BEGIN');
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const subject = `test-subject-${suffix}`;
  await client.query(`INSERT INTO auth_identities(subject,phone_e164) VALUES($1,$2)`, [subject, `+579${String(Date.now()).slice(-9)}`]);
  const profile = await client.query(`INSERT INTO affected_profiles(
      auth_subject,full_name,document_type,document_number_hash,document_last4,address,location,consent_sensitive_data_at,consent_version)
    VALUES($1,'Synthetic Victim','CC',$2,'0000','Synthetic address',ST_SetSRID(ST_MakePoint(-75.5,5.0),4326)::geography,now(),'test-v1')
    RETURNING id`, [subject, `test-doc-${suffix}`]);
  const need = await client.query(`INSERT INTO assistance_needs(affected_profile_id,category,quantity)
    VALUES($1,'WATER',1) RETURNING id`, [profile.rows[0].id]);
  const offer = await client.query(`INSERT INTO assistance_offers(
      auth_subject,provider_name,phone_e164,category,quantity_available,location)
    VALUES($1,'Synthetic Provider',$2,'WATER',10,ST_SetSRID(ST_MakePoint(-75.5,5.0),4326)::geography)
    RETURNING id`, [subject, `+578${String(Date.now()).slice(-9)}`]);
  const match = await client.query(`INSERT INTO assistance_matches(need_id,offer_id,score,distance_meters)
    VALUES($1,$2,100,0) RETURNING id`, [need.rows[0].id, offer.rows[0].id]);

  await client.query('SAVEPOINT approval_check');
  let blocked = false;
  try {
    await client.query(`UPDATE assistance_matches SET status='APPROVED' WHERE id=$1`, [match.rows[0].id]);
  } catch (error) {
    if (error.code !== '23514') throw error;
    blocked = true;
    await client.query('ROLLBACK TO SAVEPOINT approval_check');
  }
  if (!blocked) throw new Error('database allowed APPROVED assistance for non-VERIFIED beneficiary');
  await client.query('RELEASE SAVEPOINT approval_check');

  await client.query(`UPDATE affected_profiles SET verification_status='VERIFIED' WHERE id=$1`, [profile.rows[0].id]);
  const approved = await client.query(`UPDATE assistance_matches SET status='APPROVED' WHERE id=$1 RETURNING id`, [match.rows[0].id]);
  if (approved.rowCount !== 1) throw new Error('database rejected APPROVED assistance for VERIFIED beneficiary');

  console.log('verified assistance DB invariant passed');
  await client.query('ROLLBACK');
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  await client.end();
}

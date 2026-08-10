const test = require('node:test');
const assert = require('node:assert/strict');
const { AffectedService } = require('../dist/affected/affected.service');
const { AssistanceService } = require('../dist/assistance/assistance.service');

function statusOf(error) {
  return typeof error?.getStatus === 'function' ? error.getStatus() : error?.status;
}

test('non-verifier official cannot list sensitive evidence', async () => {
  const db = { query: async () => { throw new Error('database must not be reached'); } };
  const service = new AffectedService(db, {});
  await assert.rejects(
    () => service.officialEvidence('profile-1', { role: 'DISPATCHER', id: 'official-1' }, { reason: 'operational curiosity' }),
    error => statusOf(error) === 403,
  );
});

test('non-verifier official cannot request sensitive evidence download', async () => {
  const db = { query: async () => { throw new Error('database must not be reached'); } };
  const service = new AffectedService(db, {});
  await assert.rejects(
    () => service.officialEvidenceDownload('asset-1', { role: 'DISPATCHER', id: 'official-1' }, { reason: 'operational curiosity' }),
    error => statusOf(error) === 403,
  );
});

test('successful liveness result never auto-verifies a beneficiary', async () => {
  const sql = [];
  const client = {
    async query(statement) {
      sql.push(String(statement));
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  let poolQuery = 0;
  const db = {
    async query(statement) {
      sql.push(String(statement));
      poolQuery += 1;
      if (poolQuery === 1) {
        return {
          rowCount: 1,
          rows: [{
            id: 'profile-1',
            liveness_provider: 'REKOGNITION',
            liveness_provider_session_id: 'session-1',
          }],
        };
      }
      if (poolQuery === 2) {
        return {
          rowCount: 1,
          rows: [{ id: 'ls-1', provider_session_id: 'session-1', expires_at: new Date(Date.now() + 60_000).toISOString() }],
        };
      }
      throw new Error(`unexpected pool query ${poolQuery}: ${statement}`);
    },
    async connect() { return client; },
  };
  const provider = {
    async getResults() {
      return { provider: 'REKOGNITION', sessionId: 'session-1', status: 'SUCCEEDED', confidence: 99.9 };
    },
  };
  const service = new AffectedService(db, provider);
  const result = await service.completeProviderLivenessSession('profile-1', 'subject-1');
  assert.equal(result.status, 'SUCCEEDED');
  assert.ok(sql.some(statement => statement.includes('liveness_confidence')));
  assert.ok(!sql.some(statement => /verification_status\s*=/.test(statement)), 'liveness must never update beneficiary verification_status');
});

test('stale assistance match cannot be approved when identity is not VERIFIED', async () => {
  const statements = [];
  const client = {
    async query(statement) {
      statements.push(String(statement));
      if (String(statement) === 'BEGIN' || String(statement) === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (String(statement).includes('UPDATE assistance_matches')) return { rowCount: 0, rows: [] };
      if (String(statement).includes('SELECT m.id,p.verification_status')) {
        return { rowCount: 1, rows: [{ id: 'match-1', verification_status: 'PENDING_OFFICIAL_VERIFICATION' }] };
      }
      throw new Error(`unexpected query: ${statement}`);
    },
    release() {},
  };
  const db = { async connect() { return client; } };
  const service = new AssistanceService(db);
  await assert.rejects(
    () => service.approveMatch('match-1', { role: 'COORDINATOR', id: 'official-1', auth_subject: 'official-sub' }),
    error => statusOf(error) === 403,
  );
  assert.ok(statements.some(statement => statement.includes("p.verification_status='VERIFIED'")));
});

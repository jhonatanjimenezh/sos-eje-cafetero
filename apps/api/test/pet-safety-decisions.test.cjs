const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const decisions = read('apps/api/src/pets/pets-decision.service.ts');
const controller = read('apps/api/src/pets/pets.controller.ts');

test('owner and finder decisions are routed through the atomic service', () => {
  assert.match(controller, /private readonly decisions: PetsDecisionService/);
  assert.match(controller, /return this\.decisions\.ownerAction/);
  assert.match(controller, /return this\.decisions\.finderAction/);
});

test('decision service does not encode private decisions into claim lifecycle', () => {
  assert.doesNotMatch(decisions, /UPDATE\s+pet_claims\s+SET\s+status/i);
  assert.match(decisions, /INSERT INTO pet_claim_actions/);
  assert.match(decisions, /INSERT INTO pet_blocks/);
});

test('contact authorization requires ready proof-of-life evidence', () => {
  assert.match(decisions, /claim\.status !== 'EVIDENCE_READY'/);
  assert.match(decisions, /kind='PROOF_OF_LIFE' AND upload_status='READY'/);
  assert.match(decisions, /OWNER_AUTHORIZE_CONTACT/);
});

test('found-owner acceptance requires ready historical ownership evidence', () => {
  assert.match(decisions, /kind='OWNERSHIP_HISTORY' AND upload_status='READY'/);
  assert.match(decisions, /FINDER_ACCEPT_OWNER/);
});

test('private decision and security audit live in the same transaction', () => {
  const owner = decisions.slice(decisions.indexOf('async ownerAction'), decisions.indexOf('async finderAction'));
  const finder = decisions.slice(decisions.indexOf('async finderAction'));
  for (const block of [owner, finder]) {
    assert.match(block, /BEGIN/);
    assert.match(block, /INSERT INTO pet_claim_actions/);
    assert.match(block, /await this\.audit\(client/);
    assert.match(block, /COMMIT/);
    assert.match(block, /ROLLBACK/);
  }
});

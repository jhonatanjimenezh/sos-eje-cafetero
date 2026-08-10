const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const migration = read('apps/api/migrations/007_safe_pets.sql');
const service = read('apps/api/src/pets/pets.service.ts');
const controller = read('apps/api/src/pets/pets.controller.ts');
const dto = read('apps/api/src/pets/dto.ts');
const originGuard = read('apps/api/src/pets/pets-origin.guard.ts');

test('public pet projection contains only id kind name status timestamp', () => {
  const view = migration.slice(migration.indexOf('CREATE OR REPLACE VIEW public_pet_cases'));
  for (const forbidden of [
    'animal_type', 'public_description', 'breed', 'color', 'city', 'area_hint',
    'exact_location', 'created_by_subject', 'owner_auth_subject', 'phone_e164',
  ]) {
    assert.equal(view.includes(`c.${forbidden}`), false, `public view must not expose ${forbidden}`);
  }
  assert.match(service, /name: row\.public_name/);
  assert.match(service, /photoUrl: await this\.publicPhoto/);
  assert.doesNotMatch(service.slice(service.indexOf('async publicCases'), service.indexOf('async publicCase')), /exact_location|phone_e164|owner_auth_subject/);
});

test('owner personal proof uses OTP identity plus encrypted payload and keyed identifiers', () => {
  assert.match(service, /auth_identities WHERE subject=\$1/);
  assert.match(service, /createCipheriv\('aes-256-gcm'/);
  assert.match(service, /PET_PROFILE_ENCRYPTION_SECRET_B64URL/);
  assert.match(service, /PET_IDENTITY_HASH_SECRET_B64URL/);
  assert.match(service, /createHmac\('sha256'/);
  assert.doesNotMatch(migration, /owner_document_number\s+text/i);
  assert.doesNotMatch(migration, /owner_phone\s+text|finder_phone\s+text/i);
});

test('proof of life requires short-lived server challenge and video', () => {
  assert.match(service, /now\(\)\+interval '10 minutes'/);
  assert.match(service, /PET-[^`]*randomBytes/);
  assert.match(service, /La prueba de vida debe ser video/);
  assert.match(service, /challenge_id/);
  assert.match(migration, /kind <> 'PROOF_OF_LIFE' OR challenge_id IS NOT NULL/);
});

test('private evidence is short-lived access controlled and encrypted at rest', () => {
  assert.match(service, /ServerSideEncryption: 'aws:kms'/);
  assert.match(service, /NODE_ENV === 'production' && !key/);
  assert.match(service, /expiresIn: 120/);
  assert.match(service, /OWNER_VIEWED_PROOF_OF_LIFE|PET_OWNER_VIEWED_PROOF_OF_LIFE/);
  assert.match(service, /EVIDENCE_MALWARE_SCAN_MODE/);
  assert.match(service, /THREATS_FOUND/);
  assert.match(service, /ChecksumSHA256/);
  assert.match(service, /Range: 'bytes=0-31'/);
});

test('reject block abuse actions do not mutate pet claim lifecycle', () => {
  assert.doesNotMatch(migration, /pet_claims_status_ck[^;]*BLOCKED/s);
  assert.doesNotMatch(migration, /pet_claims_status_ck[^;]*ABUSE/s);
  const ownerAction = service.slice(service.indexOf('async ownerAction'), service.indexOf('async finderContact'));
  assert.equal(/UPDATE\s+pet_claims\s+SET\s+status/i.test(ownerAction), false, 'owner private decisions must not change claim status');
  const finderAction = service.slice(service.indexOf('async finderAction'), service.indexOf('async foundClaimFinderContact'));
  assert.equal(/UPDATE\s+pet_claims\s+SET\s+status/i.test(finderAction), false, 'finder private decisions must not change owner claim status');
  assert.match(service, /pet_claim_actions/);
  assert.match(service, /pet_blocks/);
});

test('contact becomes available only after explicit accepted action and consent', () => {
  assert.match(service, /action='OWNER_AUTHORIZE_CONTACT'/);
  assert.match(service, /status: 'NOT_AVAILABLE'/);
  assert.match(service, /status: 'CONTACT_AVAILABLE'/);
  assert.match(service, /share_creator_phone/);
  assert.match(service, /share_claimant_phone/);
  assert.doesNotMatch(controller, /@Get\(['"][^'"]*(?:phone|owner\?)/i);
});

test('public free text cannot smuggle contact details', () => {
  assert.match(service, /Los campos públicos no permiten teléfonos, correos, enlaces ni usuarios externos/);
  assert.match(service, /wa\\\.me|wa\.me/);
  assert.match(service, /telegram\|whatsapp/);
  assert.match(service, /(?:\+\?\\d|\\d\[\\d\\s)/);
});

test('sensitive pet mutations use authenticated citizen session and exact-origin guard', () => {
  assert.match(controller, /@UseGuards\(JwtAuthGuard, PetsOriginGuard\)/);
  assert.match(originGuard, /WEB_ORIGIN/);
  assert.match(originGuard, /allowed\.includes\(origin\)/);
  assert.match(originGuard, /\^Bearer\\s\+\\S\+\$/);
});

test('legacy flat animal_reports is not reused as pet security identity domain', () => {
  assert.equal(service.includes('animal_reports'), false);
  assert.equal(service.includes('reporter_phone'), false);
  assert.equal(controller.includes('reports/animals'), false);
});

test('feature can fail closed independently from human SOS', () => {
  assert.match(service, /FEATURE_PET_SAFETY/);
  assert.match(service, /Mascotas seguras está deshabilitado temporalmente/);
});

test('DTO does not ask for home address and separates public from private data', () => {
  assert.equal(/ownerAddress|homeAddress|address!:/i.test(dto), false);
  assert.match(dto, /privateDistinguishingMarks/);
  assert.match(dto, /ownerDocumentNumber/);
  assert.match(dto, /shareClaimantPhone/);
  assert.match(dto, /shareCreatorPhone/);
});

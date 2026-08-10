const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const migration = read('apps/api/migrations/006_safe_reunification.sql');
const service = read('apps/api/src/reunification/reunification.service.ts');
const controller = read('apps/api/src/reunification/reunification.controller.ts');
const originGuard = read('apps/api/src/reunification/reunification-origin.guard.ts');
const reunificationDto = read('apps/api/src/reunification/dto.ts');
const authService = read('apps/api/src/auth/auth.service.ts');
const authDto = read('apps/api/src/auth/dto.ts');
const otpUi = read('apps/web/app/components/OtpLogin.tsx');
const notifier = read('apps/web/app/components/ReunificationNotifier.tsx');
const serviceWorker = read('apps/web/public/sw.js');

test('target phone is represented by keyed lookup token, never a plaintext column', () => {
  assert.match(migration, /target_lookup_token text NOT NULL/);
  assert.match(service, /createHmac\('sha256'/);
  assert.match(service, /REUNIFICATION_LOOKUP_SECRET_B64URL/);
  assert.doesNotMatch(migration, /target_(?:phone|phone_e164)|searched_(?:phone|phone_e164)/i);
});

test('seeker API never exposes target presence or target activity state', () => {
  assert.match(service, /return \{ status: 'REQUEST_ACCEPTED', requestId \}/);
  assert.match(service, /return \{ status: 'WITHDRAW_REQUESTED' \}/);
  for (const forbiddenProperty of [
    /\btargetExists\s*:/,
    /\bmatched\s*:/,
    /\bdelivered\s*:/,
    /\bopened\s*:/,
    /\blastSeen\s*:/,
    /\bonline\s*:/,
    /\btargetAuthSubject\s*:/,
  ]) {
    assert.doesNotMatch(service, forbiddenProperty);
  }
  assert.doesNotMatch(controller, /@Get\(['"]search/);
  assert.doesNotMatch(controller, /@Get\(['"][^'"]*phone/);
});

test('target-private actions never mutate seeker-observable request lifecycle', () => {
  assert.doesNotMatch(migration, /status IN \([^)]*BLOCKED_BY_TARGET/s);
  assert.doesNotMatch(migration, /status IN \([^)]*ABUSE_REVIEW/s);
  assert.doesNotMatch(service, /SET\s+status='BLOCKED_BY_TARGET'/);
  assert.doesNotMatch(service, /SET\s+status='ABUSE_REVIEW'/);
  assert.match(service, /reunification_target_actions/);
  assert.match(service, /reunification_blocks/);
  assert.match(service, /REUNIFICATION_SEEKER_BLOCKED/);
  assert.match(service, /REUNIFICATION_ABUSE_REPORTED/);
  assert.equal(service.includes('notifySeeker'), false);
});

test('target contact is explicit reveal, not included in inbox listing', () => {
  assert.match(service, /ReunificationTargetAction\.REVEAL_CONTACT/);
  assert.match(service, /contactPhone: seeker\.rows\[0\]\.phone_e164/);
  const inboxMap = service.slice(service.indexOf('return result.rows.map'), service.indexOf('async inboxSummary'));
  assert.equal(inboxMap.includes('phone_e164'), false, 'inbox list must not contain seeker phone before explicit reveal');
});

test('free text cannot bypass verified contact reveal', () => {
  assert.match(reunificationDto, /NO_DIRECT_CONTACT/);
  assert.match(reunificationDto, /wa\\\.me|wa\\\.me/);
  assert.match(reunificationDto, /phone_e164 OTP-verificado/);
  assert.match(reunificationDto, /@Matches\(NO_DIRECT_CONTACT/);
});

test('cookie-authenticated mutations require exact configured browser origin', () => {
  assert.match(controller, /@UseGuards\(JwtAuthGuard, ReunificationOriginGuard\)/);
  assert.match(originGuard, /WEB_ORIGIN/);
  assert.match(originGuard, /allowed\.includes\(origin\)/);
  assert.match(originGuard, /\^Bearer\\s\+\\S\+\$/);
  assert.match(originGuard, /Origen no autorizado/);
});

test('citizen OTP uses opaque challenge and does not expose account lifecycle flow', () => {
  assert.match(authDto, /challengeId!: string/);
  assert.doesNotMatch(authDto, /VerifyOtpDto[\s\S]*phone!:/);
  assert.match(authService, /return \{ status: 'OTP_SENT', challengeId, expiresIn: 600 \}/);
  assert.match(authService, /flow: OtpFlow \| 'DENY'/);
  assert.match(otpUi, /JSON\.stringify\(\{challengeId,code\}\)/);
  assert.equal(otpUi.includes('j.flow'), false, 'browser must not receive Cognito account-state flow');
  assert.equal(otpUi.includes('j.session'), false, 'browser must not receive raw provider session');
});

test('global notice is neutral and contains no seeker identity', () => {
  assert.match(notifier, /mensajes privados de reencuentro/i);
  assert.equal(notifier.includes('seekerDisplayName'), false);
  assert.equal(notifier.includes('contactPhone'), false);
});

test('private reunification navigation is network-only and old broad cache is purged', () => {
  assert.match(serviceWorker, /CACHE_VERSION = 'sos-shell-v3'/);
  assert.match(serviceWorker, /PUBLIC_NAVIGATION_PATHS/);
  assert.match(serviceWorker, /if \(!PUBLIC_NAVIGATION_PATHS\.has\(url\.pathname\)\) return/);
  const shellLine = serviceWorker.split('\n').find(line => line.includes('CORE_SHELL')) || '';
  const navLine = serviceWorker.split('\n').find(line => line.includes('PUBLIC_NAVIGATION_PATHS =')) || '';
  for (const privatePath of ['/reencuentro', '/damnificados', '/command-center']) {
    assert.equal(shellLine.includes(privatePath), false, `${privatePath} must not be in CORE_SHELL`);
    assert.equal(navLine.includes(privatePath), false, `${privatePath} must not be cacheable navigation`);
  }
});

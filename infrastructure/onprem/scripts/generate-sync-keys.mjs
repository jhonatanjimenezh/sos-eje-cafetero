import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';

const targets = [
  '/keys/sync-encryption-private.pem',
  '/keys/sync-receipt-signing-private.pem',
];

for (const path of targets) {
  if (existsSync(path) && readFileSync(path, 'utf8').includes('PRIVATE KEY')) continue;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(path, privateKey, { mode: 0o600 });
  chmodSync(path, 0o600);
}

console.log('SecureEnvelope local private keys are present in the Docker volume.');

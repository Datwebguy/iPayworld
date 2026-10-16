import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { fetchVerdict } from '../lib/complir.js';

const account = privateKeyToAccount('0x' + '1'.repeat(64));
const recipient = '0x' + '2'.repeat(40);
const nowSeconds = Math.floor(Date.now() / 1000);
const types = { Attestation: [
  { name: 'subject', type: 'address' }, { name: 'tier', type: 'uint8' },
  { name: 'score', type: 'uint8' }, { name: 'decisionHash', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint64' }, { name: 'validUntil', type: 'uint64' }
] };
const domain = { name: 'CompliR', version: '1', chainId: 5042, verifyingContract: '0xa82edb5e111c31c63e06ef0007f2fa1a9e7eb30d' };

async function fixture(tier = 'LOW') {
  const message = { subject: recipient, tier: { LOW: 1, MEDIUM: 2, HIGH: 3 }[tier], score: tier === 'HIGH' ? 100 : 0, decisionHash: '0x' + 'a'.repeat(64), issuedAt: nowSeconds - 60, validUntil: nowSeconds + 3600 };
  const signature = await account.signTypedData({ domain, types, primaryType: 'Attestation', message });
  return { address: recipient, tier, score: message.score, reasons: [{ code: tier === 'HIGH' ? 'SANCTIONS_DIRECT' : 'NO_RISK', weight: 0 }], decisionId: 'dec_fixture', screenedAt: new Date().toISOString(), expired: false, attestation: { signature, attester: account.address, validUntil: message.validUntil, typedData: { domain, types, primaryType: 'Attestation', message } } };
}
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const options = fetcher => ({ fetcher, expectedAttester: account.address });

test('accepts a signed LOW verdict for the requested address', async () => {
  const result = await fetchVerdict(recipient, options(async () => response(await fixture())));
  assert.equal(result.verdict, 'LOW');
  assert.equal(result.signatureVerified, true);
  assert.equal(result.decisionId, 'dec_fixture');
});

test('preserves a signed HIGH verdict', async () => {
  const result = await fetchVerdict(recipient, options(async () => response(await fixture('HIGH'))));
  assert.equal(result.verdict, 'HIGH');
});

test('rejects a mismatched recipient and an expired attestation', async () => {
  const wrong = await fixture();
  wrong.address = '0x' + '3'.repeat(40);
  await assert.rejects(fetchVerdict(recipient, options(async () => response(wrong))), /invalid verdict or recipient/);
  const expired = await fixture();
  expired.expired = true;
  await assert.rejects(fetchVerdict(recipient, options(async () => response(expired))), /missing or expired/);
});

test('rejects a signature from a different attester', async () => {
  const result = await fixture();
  await assert.rejects(fetchVerdict(recipient, { ...options(async () => response(result)), expectedAttester: '0x' + '4'.repeat(40) }), /trusted key/);
});

test('waits for a 202 screen and retries transient 502 responses', async () => {
  let calls = 0;
  const delays = [];
  const fetcher = async () => {
    calls += 1;
    if (calls === 1) return response({ status: 'screening' }, 202, { 'retry-after': '2' });
    if (calls === 2) return response({ error: 'upstream' }, 502);
    return response(await fixture());
  };
  const result = await fetchVerdict(recipient, { ...options(fetcher), wait: async ms => delays.push(ms) });
  assert.equal(result.verdict, 'LOW');
  assert.deepEqual(delays, [2000, 1000]);
  assert.equal(calls, 3);
});

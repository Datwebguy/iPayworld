import { verifyTypedData } from 'viem';

// Confirmed against attester() on the Arc mainnet CompliR registry on 2026-10-15.
// Pinning it makes a key change fail closed. Override only after checking the
// new registry attester independently.
const DEFAULT_ATTESTER = '0xc742ada2872a042dd36d2e706907b4036968960c';
const REGISTRY = '0xa82edb5e111c31c63e06ef0007f2fa1a9e7eb30d';
const FIELDS = [
  { name: 'subject', type: 'address' },
  { name: 'tier', type: 'uint8' },
  { name: 'score', type: 'uint8' },
  { name: 'decisionHash', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint64' },
  { name: 'validUntil', type: 'uint64' }
];
const TIER = { LOW: 1, MEDIUM: 2, HIGH: 3 };
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function retryDelay(response, fallback = 2) {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 30) * 1000 : fallback * 1000;
}

export async function fetchVerdict(address, { fetcher = fetch, wait = sleep, baseUrl = process.env.COMPLIR_URL || 'https://trycomplir.xyz', expectedAttester = process.env.COMPLIR_ATTESTER || DEFAULT_ATTESTER, now = () => Date.now() } = {}) {
  if (!addressPattern.test(address)) throw new Error('Invalid contractor address');
  if (!addressPattern.test(expectedAttester)) throw new Error('Invalid trusted CompliR attester address');
  const endpoint = `${baseUrl.replace(/\/$/, '')}/api/v1/attestation/${address.toLowerCase()}?wait=8`;
  const deadline = now() + 60_000;
  let transientCount = 0;
  let response;
  while (now() < deadline) {
    try {
      response = await fetcher(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (response.ok && response.status === 200) break;
      if (response.status === 202 || response.status === 429 || response.status === 503 && response.headers.has('retry-after')) {
        await wait(Math.min(retryDelay(response), Math.max(0, deadline - now())));
        continue;
      }
      if ([502, 503, 504].includes(response.status) && transientCount < 3) {
        await wait(1000 * (2 ** transientCount++));
        continue;
      }
      throw new Error(`CompliR returned HTTP ${response.status}`);
    } catch (error) {
      if (String(error.message).startsWith('CompliR returned HTTP')) throw error;
      if (transientCount >= 3) throw new Error(`CompliR is unreachable: ${error.message}`);
      await wait(1000 * (2 ** transientCount++));
    }
  }
  if (!response?.ok || response.status !== 200) throw new Error('CompliR screening did not finish within 60 seconds');
  const verdict = await response.json();
  const att = verdict.attestation;
  const typed = att?.typedData;
  const msg = typed?.message;
  if (!TIER[verdict.tier] || verdict.address?.toLowerCase() !== address.toLowerCase()) throw new Error('CompliR returned an invalid verdict or recipient');
  if (verdict.expired || !typed || !msg || !/^0x[0-9a-fA-F]{130}$/.test(att.signature || '')) throw new Error('CompliR attestation is missing or expired');
  if (typed.domain?.name !== 'CompliR' || typed.domain?.version !== '1' || Number(typed.domain?.chainId) !== 5042 || typed.domain?.verifyingContract?.toLowerCase() !== REGISTRY) throw new Error('CompliR attestation has an unexpected domain');
  if (typed.primaryType !== 'Attestation' || JSON.stringify(typed.types?.Attestation) !== JSON.stringify(FIELDS)) throw new Error('CompliR attestation has an unexpected type');
  if (msg.subject?.toLowerCase() !== address.toLowerCase() || Number(msg.tier) !== TIER[verdict.tier] || !Number.isInteger(Number(msg.score)) || Number(msg.score) < 0 || Number(msg.score) > 100 || Number(msg.score) !== Number(verdict.score)) throw new Error('CompliR attestation does not match the verdict');
  if (!/^0x[0-9a-fA-F]{64}$/.test(msg.decisionHash || '') || !Number.isInteger(Number(msg.issuedAt)) || !Number.isInteger(Number(msg.validUntil)) || Number(msg.validUntil) <= Number(msg.issuedAt) || Number(msg.validUntil) <= now() / 1000 || Number(att.validUntil) !== Number(msg.validUntil)) throw new Error('CompliR attestation hash or validity is invalid');
  if (att.attester?.toLowerCase() !== expectedAttester.toLowerCase()) throw new Error('CompliR attester differs from the trusted key');
  const signatureValid = await verifyTypedData({ address: expectedAttester, domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message: msg, signature: att.signature });
  if (!signatureValid) throw new Error('CompliR signature verification failed');
  return {
    verdict: verdict.tier,
    reason: verdict.reasons?.map(item => item.code).join(', ') || verdict.rationale || 'CompliR risk decision',
    rationale: verdict.rationale,
    reasons: verdict.reasons || [],
    decisionId: verdict.decisionId,
    recommendedLimits: verdict.recommendedLimits,
    signedProof: att,
    signatureVerified: true,
    source: 'complir',
    checkedAt: verdict.screenedAt || new Date(now()).toISOString()
  };
}

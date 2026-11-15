// Thin wrapper around IntaSend's Send Money (payouts) API — the bank-
// account payout rail alongside daraja.js's M-Pesa B2C, both confirmed with
// the same Payout PIN (see financeGuard.js) before either one moves money.
// Docs: https://developers.intasend.com/guides/send-money/overview/
//
// IMPORTANT, confirmed the hard way (a live sandbox test came back "401
// Invalid token for live environment"): unlike most of IntaSend's API,
// Send Money does NOT share one base URL between sandbox and live — it
// uses two different hosts entirely:
//   sandbox: https://sandbox.intasend.com/api/v1
//   live:    https://payment.intasend.com/api/v1
// (confirmed against https://developers.intasend.com/docs/api-testing-and-
// sandbox and IntaSend's own send-money.md docs). sendMoneyBaseUrl() below
// picks the right one from the secret key's own prefix (_test_ vs _live_),
// so nothing else has to track which environment is active. The bank-codes
// lookup further down is left on the original api.intasend.com host — it's
// public/unauthenticated and already confirmed working there, so there's
// no reason to risk moving it too.
const fetch = require('node-fetch');

const BASE_URL = 'https://api.intasend.com/api/v1';
const SANDBOX_SEND_MONEY_URL = 'https://sandbox.intasend.com/api/v1';
const LIVE_SEND_MONEY_URL = 'https://payment.intasend.com/api/v1';
function sendMoneyBaseUrl(secretKey) {
  return String(secretKey || '').indexOf('_test_') !== -1 ? SANDBOX_SEND_MONEY_URL : LIVE_SEND_MONEY_URL;
}

function authHeaders(secretKey) {
  return {
    Authorization: `Bearer ${String(secretKey || '').trim()}`,
    'Content-Type': 'application/json',
  };
}

// Starts a send-money batch — one or more transactions, all sharing the
// same provider/currency/country (IntaSend's own requirement). With
// requiresApproval false ("NO"), the batch goes straight through without a
// second approve() call, matching how the existing M-Pesa B2C payout works
// (one tap, confirmed by the Payout PIN, nothing further to approve).
async function initiateSendMoney({ secretKey, provider, currency, country, transactions, requiresApproval, batchReference, callbackUrl, walletId }) {
  const body = {
    currency: currency || 'KES',
    country: country || 'KE',
    provider,
    requires_approval: requiresApproval === false ? 'NO' : 'YES',
    transactions,
  };
  if (batchReference) body.batch_reference = batchReference;
  if (callbackUrl) body.callback_url = callbackUrl;
  if (walletId) body.wallet_id = walletId;
  const res = await fetch(`${sendMoneyBaseUrl(secretKey)}/send-money/initiate/`, {
    method: 'POST',
    headers: authHeaders(secretKey),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`IntaSend send-money initiate failed: ${res.status} ${JSON.stringify(data)}`);
    // IntaSend's own plain-language reason (e.g. "You have insufficient
    // balance to send KES 500.00…"), pulled out so the caller can show it
    // to the administrator instead of a generic "could not send". Only
    // set for 4xx responses — those are about this request, and are safe
    // and useful to show; a 5xx is IntaSend's own problem and stays
    // generic.
    const first = data && Array.isArray(data.errors) ? data.errors[0] : null;
    if (res.status >= 400 && res.status < 500 && first && first.detail) {
      err.intasendDetail = String(first.detail).slice(0, 300);
      err.intasendCode = String(first.code || '');
    }
    throw err;
  }
  return data;
}

// Only needed when a batch was started with requiresApproval true — not
// used by the current "NO" flow above, kept here for when a route (some
// bank payouts need an extra OTP step per IntaSend's docs) turns out to
// need it once tested against the real sandbox.
async function approveSendMoney({ secretKey, trackingId, nonce, transactions }) {
  const res = await fetch(`${sendMoneyBaseUrl(secretKey)}/send-money/approve/`, {
    method: 'POST',
    headers: authHeaders(secretKey),
    body: JSON.stringify({ tracking_id: trackingId, nonce, transactions }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`IntaSend send-money approve failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// Polling fallback alongside the webhook (see intasendSendMoneyWebhook in
// index.js) — IntaSend's own docs recommend not relying on the callback
// alone, since it's sent once and isn't retried on delivery failure.
async function getSendMoneyStatus({ secretKey, trackingId }) {
  const res = await fetch(`${sendMoneyBaseUrl(secretKey)}/send-money/status/`, {
    method: 'POST',
    headers: authHeaders(secretKey),
    body: JSON.stringify({ tracking_id: trackingId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`IntaSend send-money status check failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// Bank name -> bank_code lookup, so the "Send to bank account" form can
// offer a dropdown instead of asking the administrator to know a numeric
// code. Still routed through the getBankList callable (rather than called
// straight from the browser) so this stays consistent with the rest of the
// app's pattern, even though IntaSend's own docs say this one endpoint
// needs no authentication at all — deliberately NOT sending the secret key
// here; sending it anyway was producing a confusing "Session expired"
// error, since the endpoint isn't expecting an auth header in the first
// place.
async function getBankCodes({ countryCode }) {
  const cc = String(countryCode || 'ke').toLowerCase();
  const res = await fetch(`${BASE_URL}/send-money/bank-codes/${cc}/`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`IntaSend bank-codes lookup failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

module.exports = { initiateSendMoney, approveSendMoney, getSendMoneyStatus, getBankCodes };

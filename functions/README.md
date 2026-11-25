# Kenokip Farm — Cloud Functions (backend)

Firebase Cloud Functions (Node.js 20) for everything the web app can't do
safely in the browser: anything that needs a secret, moves money, or must
be trusted. All functions run in `us-central1`.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Entry point. Defines and exports every function: M-Pesa deposits, payouts, webhooks, installation orders, licensing and calling |
| `roles.js` | Accounts, roles, Finance approvals and access logging. All Finance writes go through here |
| `security.js` | Authenticator-app (TOTP) enrollment and the Finance portal password |
| `financeGuard.js` | Fingerprint/Face + PIN unlock, failed-attempt lockout and security alerts |
| `privacyGuard.js` | Dates of birth and the Birthday PIN |
| `receipts.js` | Receipt signing and verification codes |
| `push.js` | Shared helper for sending push notifications (FCM) |
| `digest.js` | Weekly digest push notification |
| `kudos.js` | Team recognition messages |
| `sensors.js` | ESP32 poultry-house sensor readings, alerts and lights schedule |
| `daraja.js` | Safaricom Daraja (M-Pesa) API client |
| `intasend.js` | IntaSend bank-payout API client |
| `totp.js`, `cryptoHelpers.js` | TOTP codes and PIN/password hashing (Node `crypto` only) |
| `geo.js`, `deviceInfo.js` | Approximate location and device labels for security logs |

### One-off scripts (run from your computer, not deployed)

| Script | Purpose |
| --- | --- |
| `registerC2BUrls.js` | Registers M-Pesa C2B confirmation/validation URLs (`npm run register-c2b`, `npm run register-c2b-paybill`) |
| `check-cert.js` | Checks a Safaricom B2C certificate before saving it as a secret |
| `test-b2c.js` | Sends a test payout directly and prints Safaricom's raw response |
| `test-balance.js` | Runs a test account-balance query and prints the raw response |

These scripts read credentials from a local `c2b.env` file. Copy
`c2b.env.example` to `c2b.env` and fill it in. `c2b.env` is git-ignored;
never commit it.

## Secrets

Deployed functions read credentials from Google Secret Manager, never from
files in this repo. Set each one with:

```bash
firebase functions:secrets:set SECRET_NAME
```

Which secrets you need depends on the features you turn on. Each guide in
[`docs/`](../docs/README.md) lists its own (for example
[`SETUP-MPESA.md`](../docs/setup/SETUP-MPESA.md) and
[`SETUP-B2C.md`](../docs/setup/SETUP-B2C.md)).

## Commands

```bash
npm install          # install dependencies
npm run deploy       # firebase deploy --only functions
npm run logs         # view function logs
```

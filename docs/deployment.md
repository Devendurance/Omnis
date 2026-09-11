# Deployment (Vercel)

Target host is Vercel (Next.js, nodejs runtime API routes). No other host
is required by the architecture.

## Environment variables

### PUBLIC (safe for the browser bundle)

- `NEXT_PUBLIC_PRIVY_APP_ID`: Privy application ID. Required for login and
  the embedded primaryExecutionWallet.
- `NEXT_PUBLIC_ENABLE_P6B_TEST_MODE`: set to `true` to expose the 0.01 USDC
  test-mode toggle in the client. The server still authorizes test mode.

### SERVER-ONLY (never `NEXT_PUBLIC_`, never commit values)

- `PRIVY_APP_ID` / `PRIVY_APP_SECRET` / `PRIVY_VERIFICATION_KEY`: server-side
  Privy verification. Every purchase, approval, settlement, and reconcile
  action verifies the bearer token. Missing or invalid tokens get 401.
  Without `PRIVY_APP_SECRET`, mock tokens are rejected in production and
  real verification fails closed.
- `HEDERA_TESTNET_PAYER_ACCOUNT_ID`: Hedera testnet payer account for the
  $0.003 service payment.
- `HEDERA_TESTNET_PAYER_PRIVATE_KEY`: ECDSA key for the payer. Stays in
  `server-only` modules.
- `HEDERA_X402_SERVICE_ACCOUNT_ID`: receiver account paid by the x402 flow.
- `BLOCKY402_TESTNET_URL`: must be the hosted Blocky402 testnet facilitator
  (`https://api.testnet.blocky402.com`). The payer uses only the currently
  advertised fee payer from `/supported`.
- `OMNIS_PUBLIC_ORIGIN`: bare https origin of the deployment, for example
  `https://omnis.vercel.app`. No path, query, or trailing slash. Used to
  allowlist the hosted x402 endpoint
  (`/api/services/wallet-activity`). Any other value shape throws at config
  read time. In production the payer resolves the service endpoint from this
  origin, so no localhost assumption remains in production paths.
- `OMNIS_DEMO_PURCHASES_ENABLED`: set to `true` to allow live service
  purchases in production for allowlisted judges. Absent or any other value
  keeps purchases disabled (503, no spend).
- `OMNIS_DEMO_ALLOWLIST`: comma-separated Privy subject DIDs permitted to
  trigger demo purchases. Exact match only. Non-allowlisted subjects are
  rejected before any spend.
- `OMNIS_DEMO_MAX_PURCHASES_PER_SUBJECT`: per-judge purchase cap, default 3,
  hard max 10. About $0.009 total at the default.
- `ENABLE_P6B_TEST_MODE`: authorizes P6B test mode on a hosted deployment.
  Without it, test-mode requests get 403.
- `OMNIS_P4A_SPIKE_TOKEN`: caller secret for the dev-only x402 entrypoint.
  The dev route returns 404 in production regardless of this value.

### OPTIONAL DEMO

- `ARC_TESTNET_FALLBACK_API_URL` / `ARC_TESTNET_RPC_FALLBACK_URL`: optional
  Arc endpoints. Defaults point at the public Arc Testnet RPC and ArcScan.
- `OMNIS_ALLOW_MOCK_AUTH`: test and local development only. Mock tokens are
  rejected in production unless this is explicitly `true`. Never set it to
  `true` on the public deployment.

## Vercel setup

1. Import the public GitHub repository (`https://github.com/Devendurance/Omnis`).
2. Framework preset: Next.js. Build command `npm run build`, output default.
3. Add the PUBLIC variables plus every SERVER-ONLY variable above in the
   Vercel project environment (Production environment at minimum).
4. Set `OMNIS_PUBLIC_ORIGIN` to the exact deployment origin after the first
   deploy, then redeploy so the x402 endpoint allowlist matches.
5. Fund the Hedera demo payer with only a few cents of testnet USDC. The
   durable spend controls are the allowlist, the P2 per-task caps, exact
   price validation, and this small balance.
6. Do not set `OMNIS_ALLOW_MOCK_AUTH=true` in production.

## Privy production configuration

- Create (or promote) a Privy production app and set its ID in both
  `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_ID`.
- Set `PRIVY_APP_SECRET` and `PRIVY_VERIFICATION_KEY` from the Privy
  dashboard into the Vercel server environment.
- Add the deployment origin to the Privy app allowlisted origins.
- Embedded wallets default to Arc Testnet (chain ID 5042002); the client
  switches the primaryExecutionWallet to Arc Testnet before signing.

## Hedera payer funding

- Fund `HEDERA_TESTNET_PAYER_ACCOUNT_ID` with a few cents of HTS USDC
  (token 0.0.429274) on hedera:testnet plus enough HBAR for fees.
- Keep the balance small on purpose: it bounds worst-case demo spend even
  if every other control failed.

## Demo guard configuration

- Production purchases require all of: authenticated Privy session,
  `OMNIS_DEMO_PURCHASES_ENABLED=true`, subject present in
  `OMNIS_DEMO_ALLOWLIST`, and remaining per-subject allowance.
- Unknown judges (DID not allowlisted) receive an explicit not-allowed
  response and no money moves. They can still explore the landing page,
  the public `/evidence` surface, login with Privy, view services, and
  trigger the unpaid x402 402 challenge.
- Messaging on `/evidence` states "live demo spending is restricted" and
  points at the demo video for the full write path.

## P6B test mode

- Production test mode requires `ENABLE_P6B_TEST_MODE=true` on the server.
  A client query flag alone cannot enable it.
- Test mode executes a 0.01 USDC infrastructure check on Arc Testnet. The
  original 50 USDC contractor mandate is never executed in test mode.

## Post-deploy smoke commands

Run against the hosted origin (no new real payment):

```sh
BASE=https://<deployment-origin>
curl -s "$BASE/api/services" | head -c 500
curl -s -X POST "$BASE/api/services/wallet-activity" \
  -H 'content-type: application/json' -d '{"wallet":"0x0000000000000000000000000000000000000000"}' \
  -w '\nHTTP %{http_code}\n'
curl -s "$BASE/evidence" | grep -o 'Verified hackathon demo evidence'
curl -s -X POST "$BASE/api/tasks/service-purchase" \
  -H 'content-type: application/json' -d '{"action":"start-wallet-check"}' \
  -w '\nHTTP %{http_code}\n'
```

Expected: services registry 200, wallet-activity 402 (unpaid challenge) or
400/422 on invalid input (never a silent success), `/evidence` contains the
heading, service-purchase without a token is 401. Then open `/app`,
`/app/wallet`, and `/evidence` in a browser at 1440px and 375px and confirm
a clean console on the flagship path.

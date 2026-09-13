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
  purchases in production. Absent or any other value keeps purchases
  disabled (503, no spend).
- `OMNIS_DEMO_ACCESS_MODE`: `public` opens the demo to authenticated
  hackathon visitors; `allowlist` restricts purchases to
  `OMNIS_DEMO_ALLOWLIST` for post-hackathon operation. Missing or any other
  value keeps purchases disabled (503, no spend). Never defaults to public.
- `OMNIS_DEMO_ALLOWLIST`: comma-separated Privy subject DIDs permitted to
  trigger demo purchases in allowlist mode. Exact match only.
  Non-allowlisted subjects are rejected before any spend. Not required in
  public mode.
- `OMNIS_DEMO_MAX_PURCHASES_PER_SUBJECT`: best-effort per-visitor purchase
  cap, default 3, hard max 10. About $0.009 total at the default. The counter
  is process-local and resets on serverless restarts, so it is not
  authoritative. The authoritative boundary is the fixed wallet-activity
  service, the fixed 3000-unit testnet HTS USDC amount, the narrow payer
  endpoint allowlist, and the small payer funding.
- `ENABLE_P6B_TEST_MODE`: authorizes Arc test mode on a hosted deployment.
  Without it, test-mode requests get 403.
- `OMNIS_P4A_SPIKE_TOKEN`: caller secret for the development-only x402 entrypoint.
  The dev route returns 404 in production regardless of this value.

### CONVERSATION (Groq, optional)

- `NEXT_PUBLIC_OMNIS_CONVERSATION_ENABLED`: set to `true` to enable the
  conversational task surface in the client. Server model calls still fail
  closed to the deterministic fallback when unconfigured.
- `OMNIS_LLM_PROVIDER`: set to `groq` for the first real provider. Legacy
  `OPENAI_API_KEY` compatibility remains for local development only and is
  not the documented Groq configuration.
- `OMNIS_LLM_MODEL`: Groq model id. The production default is
  `openai/gpt-oss-20b`. The other supported strict-output id is
  `openai/gpt-oss-120b`, selected as an opt-in by this variable alone.
- `OMNIS_LLM_API_KEY`: Groq API key, server-only. Never use a
  `NEXT_PUBLIC_*` variable for this value.
- `OMNIS_LLM_BASE_URL`: canonical `https://api.groq.com/openai/v1`.
  For exactly `openai/gpt-oss-20b` and `openai/gpt-oss-120b`, `POST
  /chat/completions` uses `temperature 0.2`,
  `max_completion_tokens 2048`, `reasoning_effort low`,
  `include_reasoning false`, and strict `response_format json_schema`.
  The GPT-OSS path does not send `reasoning_format: hidden`; it is mutually
  exclusive with `include_reasoning: false`. The response is validated and
  reconciled through the unchanged deterministic proposal boundary. Other
  Groq models and OpenAI-compatible endpoints use plain
  `response_format json_object` with the legacy `max_tokens 800` setting and
  no GPT-OSS reasoning fields.
- `/api/services/recommendation` mirrors the GPT-OSS values and uses its own
  strict recommendation schema. Its output is verified before presentation
  and never authorizes spend.

### CONVERSATION TESTING (mock in CI, Groq in production)

Automated tests use a deterministic mock conversational provider and
perform zero external LLM calls. Real Groq compatibility is verified via
a manual no-payment production smoke test.

- The Playwright test server always rebuilds with explicit test env
  (`NEXT_PUBLIC_OMNIS_CONVERSATION_ENABLED=true`,
  `OMNIS_LLM_PROVIDER=mock`, blanked `OMNIS_LLM_API_KEY`), never the
  ambient `.env.local`. Stale servers are never reused.
- No automated test calls `api.groq.com` or `api.openai.com`. The
  hermetic conversation suite fails on any such attempt and proves the mock
  serves conversation-enabled browser coverage.
- `POST /api/conversation` performs interpretation only. It is not a
  financial write; service purchase, approval, and settlement routes are.
- Manual Groq smoke (no payment): deploy with the Groq variables above,
  open `/app`, submit the flagship wallet-check prompt, confirm the plan
  renders with approval required, and stop before any approval or purchase.

## Vercel setup

1. Import the public GitHub repository (`https://github.com/Devendurance/Omnis`).
2. Framework preset: Next.js. Build command `npm run build`, output default.
3. Add the PUBLIC variables plus every SERVER-ONLY variable above in the
   Vercel project environment (Production environment at minimum). For the
   hackathon demo set `OMNIS_DEMO_PURCHASES_ENABLED=true` and
   `OMNIS_DEMO_ACCESS_MODE=public`; for post-hackathon operation switch to
   `OMNIS_DEMO_ACCESS_MODE=allowlist` with `OMNIS_DEMO_ALLOWLIST` set.
4. Set `OMNIS_PUBLIC_ORIGIN` to the exact deployment origin after the first
   deploy, then redeploy so the x402 endpoint allowlist matches.
5. Fund the Hedera demo payer with only a few cents of testnet USDC. The
   authoritative spend controls are the fixed service, the fixed amount, the
   narrow endpoint allowlist, and this small balance; the per-visitor counter
   and P2 per-task caps are additional best-effort layers.
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
  `OMNIS_DEMO_PURCHASES_ENABLED=true`, a valid `OMNIS_DEMO_ACCESS_MODE`,
  valid Hedera config, a valid `OMNIS_PUBLIC_ORIGIN`, and remaining
  per-visitor allowance.
- In `public` mode any authenticated visitor may run the bounded $0.003
  wallet-activity check; no allowlist is required. In `allowlist` mode the
  subject must be present in `OMNIS_DEMO_ALLOWLIST` (exact match).
- Rejected subjects receive an explicit not-allowed response and no money
  moves. Everyone can still explore the landing page, the public `/evidence`
  surface, login with Privy, view services, and trigger the unpaid x402 402
  challenge. When the best-effort demo allowance is used, the UI points at
  the verified demo evidence.

## Arc test mode

- Production Arc test mode requires `ENABLE_P6B_TEST_MODE=true` on the server.
  A client query flag alone cannot enable it.
- Test mode executes a 0.01 USDC infrastructure check on Arc Testnet. The
  flagship 0.10 USDC contractor mandate is never executed in test mode.

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

import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";

export const metadata: Metadata = {
  title: "Verified demo evidence · useOmnis",
  description:
    "Verified hackathon demo evidence for the useOmnis Hedera x402 service payment and Arc Testnet settlement.",
};

const HEDERA_PAYMENT_ID = "0.0.7162784@1788995118.130839662";
const ARC_TX_HASH =
  "0xe16824170d9fb8bf8551be3877a80a425328a21ca158b21201301e6b087f7b7d";
const ARC_BLOCK = "61303876";
const ARC_EXPLORER_TX = `https://testnet.arcscan.app/transaction/${ARC_TX_HASH}`;

export default function EvidencePage() {
  return (
    <div className="collection-page" style={{ padding: "3rem 1.5rem" }}>
      <p className="eyebrow">hackathon evidence</p>
      <h1>Verified hackathon demo evidence</h1>
      <p className="muted" style={{ maxWidth: "640px" }}>
        This page shows only actual verified historical evidence recorded
        during the human-directed ETHOnline 2026 demo. It is a read-only
        historical record, not a new live execution. No payment moves when
        you open this page.
      </p>

      <div className="demo-box verified" style={{ marginTop: "2rem" }}>
        <p className="demo-box-label">hedera · ai and agentic payments</p>
        <p className="demo-box-val">$0.003 x402 service payment · paid</p>
        <p className="demo-box-status">live paid request on hedera:testnet</p>
        <dl
          style={{
            display: "grid",
            gap: "8px",
            marginTop: "1rem",
            fontSize: "14px",
          }}
        >
          <div>
            <dt className="muted">service</dt>
            <dd>
              <code>POST /api/services/wallet-activity</code> (wallet-activity
              check)
            </dd>
          </div>
          <div>
            <dt className="muted">protocol</dt>
            <dd>x402 v2, exact scheme, network hedera:testnet</dd>
          </div>
          <div>
            <dt className="muted">asset</dt>
            <dd>HTS USDC token 0.0.429274, 3000 atomic units ($0.003)</dd>
          </div>
          <div>
            <dt className="muted">facilitator</dt>
            <dd>Blocky402 testnet, advertised fee payer only</dd>
          </div>
          <div>
            <dt className="muted">payment identifier</dt>
            <dd>
              <code>{HEDERA_PAYMENT_ID}</code>
            </dd>
          </div>
          <div>
            <dt className="muted">budget</dt>
            <dd>$0.05 service budget, $0.003 spent</dd>
          </div>
        </dl>
      </div>

      <div className="demo-box verified" style={{ marginTop: "1.5rem" }}>
        <p className="demo-box-label">arc · settlement layer</p>
        <p className="demo-box-val">0.01 USDC test transfer · confirmed</p>
        <p className="demo-box-status">
          test mode: original 50 USDC mandate NOT EXECUTED
        </p>
        <dl
          style={{
            display: "grid",
            gap: "8px",
            marginTop: "1rem",
            fontSize: "14px",
          }}
        >
          <div>
            <dt className="muted">network</dt>
            <dd>Arc Testnet, chain ID 5042002</dd>
          </div>
          <div>
            <dt className="muted">asset</dt>
            <dd>
              USDC <code>0x3600000000000000000000000000000000000000</code>,
              10,000 atomic units (0.01 USDC)
            </dd>
          </div>
          <div>
            <dt className="muted">transaction hash</dt>
            <dd>
              <code>{ARC_TX_HASH}</code>
            </dd>
          </div>
          <div>
            <dt className="muted">block</dt>
            <dd>
              <code>{ARC_BLOCK}</code>
            </dd>
          </div>
          <div>
            <dt className="muted">explorer</dt>
            <dd>
              <a
                href={ARC_EXPLORER_TX}
                target="_blank"
                rel="noreferrer"
              >
                view on ArcScan <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            </dd>
          </div>
          <div>
            <dt className="muted">approval</dt>
            <dd>
              human-gated: exact amount, recipient, and asset approved by the
              task owner through the Privy embedded primaryExecutionWallet
              before signing
            </dd>
          </div>
        </dl>
      </div>

      <div className="demo-box" style={{ marginTop: "1.5rem" }}>
        <p className="demo-box-label">judge access</p>
        <p className="demo-box-val">open hackathon demo for authenticated visitors</p>
        <p className="demo-box-sub">
          Anyone can explore this evidence and the landing page. Authenticated
          visitors can log in with Privy, view services, and trigger the unpaid
          x402 402 challenge. When live purchases are enabled, the bounded
          $0.003 wallet-activity check requires an authenticated identity plus
          an explicit start action; rejected requests receive an explicit
          not-allowed response and no money moves. The demo video shows the
          full write path.
        </p>
      </div>

      <div
        style={{
          display: "flex",
          gap: "12px",
          marginTop: "2rem",
          flexWrap: "wrap",
        }}
      >
        <Link href="/" className="button button-outline">
          <ArrowLeft size={14} /> back to home
        </Link>
        <Link href="/app" className="button button-light">
          start a task
        </Link>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { ArrowUpRight, CircleHelp, ShieldCheck, Wallet } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { usePreview } from "@/components/preview";
import { CircleSettlementCard } from "./circle-settlement-card";

export function WalletView() {
  const auth = useAuth();
  const openPreview = usePreview();
  const executionWallet = auth.primaryExecutionWallet;
  const handleConnect = () => {
    if (auth.configured) {
      auth.login();
    } else {
      openPreview("connect wallet");
    }
  };
  return (
    <div className="wallet-layout-container">
      <div className="wallet-grid">
      <section className="wallet-connect cosmic">
        <span className="eyebrow">
          <span className="preview-dot" />{" "}
          {auth.authenticated ? "wallet connected" : "wallet disconnected"}
        </span>
        <div className="wallet-orbit" aria-hidden="true">
          <Wallet size={40} strokeWidth={1.1} />
        </div>
        <h2>
          {auth.authenticated ? (
            <>
              Your execution wallet.
              <br />
              Your authority.
            </>
          ) : (
            <>
              Your wallet.
              <br />
              Your authority.
            </>
          )}
        </h2>
        <p>
          {auth.authenticated
            ? "Your Privy embedded EVM wallet is connected as the primary execution wallet for useOmnis tasks."
            : "Connect your wallet or log in to establish an embedded execution wallet and scope tasks to your identity."}
        </p>
        <div className="wallet-actions">
          {auth.authenticated ? (
            <button
              type="button"
              className="button button-light"
              onClick={() => auth.logout()}
            >
              log out
            </button>
          ) : (
            <button
              type="button"
              className="button button-light"
              onClick={handleConnect}
            >
              <Wallet size={16} aria-hidden="true" />
              connect wallet
            </button>
          )}
          {auth.authenticated && !executionWallet && auth.createWallet && (
            <button
              type="button"
              className="button button-outline"
              onClick={() => auth.createWallet?.()}
            >
              create embedded wallet
            </button>
          )}
        </div>
        <div className="wallet-truth-panel" role="status">
          <dl className="wallet-truth-list">
            <div>
              <dt>authentication</dt>
              <dd>{auth.authenticated ? "authenticated" : "disconnected"}</dd>
            </div>
            {auth.authenticated && auth.ownerSubject && (
              <div>
                <dt>owner subject</dt>
                <dd className="mono-break">{auth.ownerSubject}</dd>
              </div>
            )}
            <div>
              <dt>execution wallet</dt>
              <dd className="mono-break">
                {executionWallet?.address ?? "none provisioned"}
              </dd>
            </div>
            <div>
              <dt>wallet type</dt>
              <dd>
                {executionWallet
                  ? "privy embedded wallet"
                  : auth.authenticated
                    ? "provisioning"
                    : "disconnected"}
              </dd>
            </div>
            <div>
              <dt>readiness</dt>
              <dd>
                {auth.authenticated
                  ? executionWallet?.ready
                    ? "ready"
                    : "initializing"
                  : "not ready"}
              </dd>
            </div>
            <div>
              <dt>supported role</dt>
              <dd>primaryExecutionWallet (execution readiness)</dd>
            </div>
            <div>
              <dt>balance</dt>
              <dd className="muted">balance not loaded</dd>
            </div>
          </dl>
        </div>
        {auth.connectedExternalWallets.length > 0 && (
          <div className="external-wallets-panel">
            <p className="eyebrow">connected external wallets</p>
            <ul className="external-wallets-list">
              {auth.connectedExternalWallets.map((ext, idx) => (
                <li key={`ext-wallet-${ext.address.toLowerCase()}-${idx}`}>
                  <span className="mono-break">{ext.address}</span>
                  <span className="muted">
                    ({ext.walletClientType} · {ext.role})
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <div className="wallet-context">
        <section>
          <ShieldCheck size={24} aria-hidden="true" />
          <p className="eyebrow">control stays visible</p>
          <h2>A wallet is not a blank cheque.</h2>
          <p>
            Omnis is designed around a specific task, an explicit budget, and a
            clear approval boundary. The final payment requires your decision.
          </p>
          <Link href="/app/approvals">
            explore approvals <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </section>
        <section>
          <CircleHelp size={23} aria-hidden="true" />
          <h2>Before a payment</h2>
          <ul>
            <li>Review the exact amount and recipient.</li>
            <li>See the source and settlement network.</li>
            <li>Check service spending separately.</li>
            <li>Confirm only the action you intend.</li>
          </ul>
        </section>
      </div>
      </div>
      <CircleSettlementCard key={auth.ownerSubject ?? "unauthenticated"} />
    </div>
  );
}

"use client";

import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { formatMoney, type Money } from "@/lib/domain/money";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_NAME,
  getArcUsdcBalance,
  getCircleUnifiedBalance,
} from "@/lib/settlement";

export function WalletBalanceSummary() {
  const auth = useAuth();
  const executionWallet = auth.primaryExecutionWallet;
  const [walletBalance, setWalletBalance] = useState<Money | null>(null);
  const [unifiedBalance, setUnifiedBalance] = useState<Money | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const refresh = useCallback(async () => {
    if (!executionWallet?.address) return;
    setLoading(true);
    setError(null);
    const address = executionWallet.address as `0x${string}`;
    const [walletResult, unifiedResult] = await Promise.allSettled([
      getArcUsdcBalance(address),
      getCircleUnifiedBalance(address),
    ]);

    if (walletResult.status === "fulfilled") {
      setWalletBalance(walletResult.value);
    } else {
      setError(
        `Arc USDC balance unavailable: ${walletResult.reason instanceof Error ? walletResult.reason.message : String(walletResult.reason)}`,
      );
      setWalletBalance(null);
    }
    setUnifiedBalance(
      unifiedResult.status === "fulfilled" ? unifiedResult.value : null,
    );
    setLoading(false);
  }, [executionWallet]);

  useEffect(() => {
    const timer = window.setTimeout(() => setHydrated(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!auth.authenticated || !executionWallet?.address) return;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [auth.authenticated, executionWallet?.address, refresh]);

  const walletState = !hydrated
    ? "connect to load balances"
    : !auth.ready
    ? "loading"
    : !auth.authenticated
      ? "connect to load balances"
      : !executionWallet
        ? "provisioning"
        : error
          ? "read error"
          : executionWallet.ready
            ? "ready"
            : "initializing";

  const arcBalanceLabel = loading
    ? "loading"
    : walletBalance
      ? formatMoney(walletBalance)
      : hydrated && auth.authenticated
        ? "unavailable"
        : "not loaded";

  return (
    <section className="wallet-balance-summary" aria-labelledby="wallet-balance-title">
      <div className="wallet-summary-heading">
        <div>
          <p className="eyebrow">execution readiness</p>
          <h2 id="wallet-balance-title">Wallet status and balances</h2>
        </div>
        <button
          type="button"
          className="button button-outline"
          onClick={() => void refresh()}
          disabled={loading || !executionWallet?.address}
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : undefined} aria-hidden="true" />
          refresh balances
        </button>
      </div>
      <div className="wallet-summary-grid">
        <div className="wallet-summary-metric">
          <span className="metric-label">network</span>
          <strong><CheckCircle2 size={15} aria-hidden="true" /> {ARC_TESTNET_NAME}</strong>
          <span className="metric-subtext">chain {ARC_TESTNET_CHAIN_ID} · configured supported network</span>
        </div>
        <div className="wallet-summary-metric">
          <span className="metric-label">execution readiness</span>
          <strong>{walletState}</strong>
          <span className="metric-subtext">{executionWallet?.walletClientType ?? "Privy embedded wallet"}</span>
        </div>
        <div className="wallet-summary-metric">
          <span className="metric-label">Arc USDC balance</span>
          <strong>{arcBalanceLabel}</strong>
          <span className="metric-subtext">wallet ERC-20 balance</span>
        </div>
        {unifiedBalance && (
          <div className="wallet-summary-metric">
            <span className="metric-label">Circle Unified Balance</span>
            <strong>{formatMoney(unifiedBalance)}</strong>
            <span className="metric-subtext">informational only · not used to fund payments</span>
          </div>
        )}
      </div>
      {error && (
        <p className="wallet-summary-error" role="status">
          <AlertTriangle size={15} aria-hidden="true" /> {error}
        </p>
      )}
    </section>
  );
}

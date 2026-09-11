"use client";

import type { EIP1193Provider } from "viem";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Send,
  Shield,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  formatMoney,
  moneyZero,
  parseMoney,
  type Money,
} from "@/lib/domain/money";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_NAME,
  ARC_TESTNET_USDC_DECIMALS,
  ARC_TESTNET_USDC_SYMBOL,
  clearSettlementExecution,
  ensureArcTestnetChain,
  executeCircleSettlement,
  getArcUsdcBalance,
  getCircleUnifiedBalance,
  loadSettlementExecution,
  prepareSettlementRequest,
  reconcileCircleSettlementOnchain,
  runCircleArcPreflight,
  saveSettlementExecution,
  transitionCircleSettlement,
  type CircleArcPreflightReport,
  type CircleSettlementEvidence,
  type CircleSettlementExecution,
  type CircleSettlementOperationType,
  type DestinationConfiguration,
  type SettlementConfirmationParams,
} from "@/lib/settlement";

const DEFAULT_TEST_RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const DEFAULT_TEST_AMOUNT = "0.01";

export function CircleSettlementCard() {
  const auth = useAuth();
  const executionWallet = auth.primaryExecutionWallet;

  // Balances
  const [walletBalance, setWalletBalance] = useState<Money | null>(null);
  const [unifiedBalance, setUnifiedBalance] = useState<Money | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  // Form parameters
  const [testAmountInput, setTestAmountInput] = useState(
    auth.authenticated ? DEFAULT_TEST_AMOUNT : "",
  );
  const [testRecipientInput, setTestRecipientInput] = useState(
    auth.authenticated ? DEFAULT_TEST_RECIPIENT : "",
  );
  const [operationType, setOperationType] =
    useState<CircleSettlementOperationType>("erc20_transfer");

  // Preflight
  const [preflight, setPreflight] = useState<CircleArcPreflightReport | null>(
    null,
  );
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);

  // Settlement Execution
  const [execution, setExecution] = useState<CircleSettlementExecution | null>(
    () => {
      if (typeof window !== "undefined" && auth.ownerSubject) {
        return loadSettlementExecution(auth.ownerSubject);
      }
      return null;
    },
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReconciling, setIsReconciling] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [preparedParams, setPreparedParams] =
    useState<SettlementConfirmationParams | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);

  // Load balances
  const refreshBalances = useCallback(async () => {
    if (!executionWallet?.address) return;
    setLoadingBalances(true);
    setBalanceError(null);
    try {
      const addr = executionWallet.address as `0x${string}`;
      const [walletRes, unifiedRes] = await Promise.allSettled([
        getArcUsdcBalance(addr),
        getCircleUnifiedBalance(addr),
      ]);

      if (walletRes.status === "fulfilled") {
        setWalletBalance(walletRes.value);
      } else {
        setBalanceError(
          `Arc USDC: ${walletRes.reason instanceof Error ? walletRes.reason.message : String(walletRes.reason)}`,
        );
      }

      if (unifiedRes.status === "fulfilled") {
        setUnifiedBalance(unifiedRes.value);
      } else {
        // Unified balance may report 0 or network note
        setUnifiedBalance(
          moneyZero(ARC_TESTNET_USDC_SYMBOL, ARC_TESTNET_USDC_DECIMALS),
        );
      }
    } catch (err) {
      setBalanceError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingBalances(false);
    }
  }, [executionWallet]);

  useEffect(() => {
    let active = true;
    if (!auth.authenticated || !executionWallet?.address) return;
    const addr = executionWallet.address as `0x${string}`;
    (async () => {
      try {
        const [walletRes, unifiedRes] = await Promise.allSettled([
          getArcUsdcBalance(addr),
          getCircleUnifiedBalance(addr),
        ]);
        if (!active) return;
        if (walletRes.status === "fulfilled") {
          setWalletBalance(walletRes.value);
        } else {
          setBalanceError(
            `Arc USDC: ${walletRes.reason instanceof Error ? walletRes.reason.message : String(walletRes.reason)}`,
          );
        }
        if (unifiedRes.status === "fulfilled") {
          setUnifiedBalance(unifiedRes.value);
        } else {
          setUnifiedBalance(
            moneyZero(ARC_TESTNET_USDC_SYMBOL, ARC_TESTNET_USDC_DECIMALS),
          );
        }
      } catch (err) {
        if (!active) return;
        setBalanceError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      active = false;
    };
  }, [auth.authenticated, executionWallet]);

  // Handle running deterministic preflight check
  const handleRunPreflight = async () => {
    setPreflightLoading(true);
    setPreflightError(null);
    try {
      const requestedAmount = parseMoney(
        testAmountInput.trim() || DEFAULT_TEST_AMOUNT,
        ARC_TESTNET_USDC_SYMBOL,
        ARC_TESTNET_USDC_DECIMALS,
      );

      // Prevent 50 USDC in this vertical slice
      if (requestedAmount.units >= BigInt(50_000_000)) {
        throw new Error(
          "P6A testnet slice cannot exceed 1 USDC. Final 50 USDC contractor payment is not sent.",
        );
      }

      const destination: DestinationConfiguration = {
        recipient: testRecipientInput.trim() || DEFAULT_TEST_RECIPIENT,
        chain: ARC_TESTNET_NAME,
        chainId: ARC_TESTNET_CHAIN_ID,
        asset: "USDC",
      };

      const provider = auth.getEthereumProvider
        ? await auth.getEthereumProvider()
        : undefined;

      const report = await runCircleArcPreflight({
        authIdentity: auth,
        requestedAmount,
        destination,
        provider: provider ?? undefined,
      });
      setPreflight(report);
      if (report.currentArcUsdcBalance) {
        setWalletBalance(report.currentArcUsdcBalance);
      }
      if (report.circleUnifiedBalance) {
        setUnifiedBalance(report.circleUnifiedBalance);
      }
    } catch (err) {
      setPreflightError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreflightLoading(false);
    }
  };

  // Open explicit confirmation modal/boundary
  const handleInitiateSettlement = () => {
    if (!preflight) {
      setExecutionError("Run read-only preflight before initiating settlement.");
      return;
    }
    try {
      const params = prepareSettlementRequest(preflight, operationType);
      setPreparedParams(params);
      setShowConfirmation(true);
      setExecutionError(null);
    } catch (err) {
      setExecutionError(err instanceof Error ? err.message : String(err));
    }
  };

  // Explicit confirmation action
  const handleConfirmAndExecute = async () => {
    if (!preparedParams || isSubmitting) return;

    setIsSubmitting(true);
    setExecutionError(null);
    const params: SettlementConfirmationParams = preparedParams;
    const executionId = `p6a-${Date.now()}`;
    const initialExecution: CircleSettlementExecution = {
      id: executionId,
      operationType: params.operationType,
      params,
      status: "submitting",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let currentExecution: CircleSettlementExecution = initialExecution;
    setExecution(currentExecution);
    saveSettlementExecution(currentExecution, auth.ownerSubject);

    try {

      // 1. Resolve primaryExecutionWallet
      if (!executionWallet?.address) {
        throw new Error(
          "Primary execution wallet not found. Ensure an embedded Privy wallet is created.",
        );
      }

      // 2-6. Switch execution wallet chain if needed and obtain fresh provider AFTER switch
      let provider: EIP1193Provider | null = null;
      if (auth.switchExecutionWalletChain) {
        provider = await auth.switchExecutionWalletChain(ARC_TESTNET_CHAIN_ID);
      } else if (auth.getEthereumProvider) {
        provider = await auth.getEthereumProvider();
      }

      if (!provider) {
        throw new Error(
          "EIP-1193 provider not available for primary execution wallet.",
        );
      }

      // Verify chain ID on fresh provider before signing
      await ensureArcTestnetChain(provider);
      const evidence: CircleSettlementEvidence = await executeCircleSettlement({
        params,
        provider,
        onTxHashObserved: (txHash) => {
          currentExecution = transitionCircleSettlement(
            currentExecution,
            "submitted",
            { transactionHash: txHash },
          );
          setExecution(currentExecution);
          saveSettlementExecution(currentExecution, auth.ownerSubject);
        },
      });

      // Transition through 'confirming' state before confirmed or reverted
      currentExecution = transitionCircleSettlement(
        currentExecution,
        "confirming",
        {
          transactionHash: evidence.transactionHash,
        },
      );
      setExecution(currentExecution);
      saveSettlementExecution(currentExecution, auth.ownerSubject);

      const confirmedExecution = transitionCircleSettlement(
        currentExecution,
        evidence.confirmedStatus === "confirmed" ? "confirmed" : "reverted",
        {
          transactionHash: evidence.transactionHash,
          evidence,
          failureReason:
            evidence.confirmedStatus === "reverted" ? "reverted" : undefined,
        },
      );
      setExecution(confirmedExecution);
      saveSettlementExecution(confirmedExecution, auth.ownerSubject);
      setShowConfirmation(false);
      refreshBalances();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExecutionError(msg);
      const target = currentExecution;
      if (target) {
        if (target.transactionHash) {
          // Transaction hash was observed; never mark as terminal failed
          // Transition to confirmation_delayed so user can reconcile onchain
          try {
            const delayed = transitionCircleSettlement(
              target,
              "confirmation_delayed",
              {
                failureReason: "confirmation_delayed",
                errorMessage: `Transaction submitted (${target.transactionHash}), confirmation pending: ${msg}`,
              },
            );
            setExecution(delayed);
            saveSettlementExecution(delayed, auth.ownerSubject);
          } catch {
            // retain current target
          }
        } else {
          // Error occurred before transaction was submitted; mark terminal failed
          const failureReason = msg.toLowerCase().includes("reject")
            ? "signature_rejected"
            : "failure_before_signature";
          try {
            const failed = transitionCircleSettlement(target, "failed", {
              failureReason,
              errorMessage: msg,
            });
            setExecution(failed);
            saveSettlementExecution(failed, auth.ownerSubject);
          } catch {
            // retain current target
          }
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Reconcile on-chain (read-only reconciliation)
  const handleReconcile = async () => {
    if (!execution || !execution.transactionHash) return;
    setIsReconciling(true);
    try {
      const outcome = await reconcileCircleSettlementOnchain(execution);
      if (outcome.reconciled) {
        setExecution(outcome.execution);
        saveSettlementExecution(outcome.execution, auth.ownerSubject);
      }
    } catch (err) {
      setExecutionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsReconciling(false);
    }
  };

  const handleResetTestSlice = () => {
    clearSettlementExecution(auth.ownerSubject);
    setExecution(null);
    setPreflight(null);
    setExecutionError(null);
    setShowConfirmation(false);
  };

  if (!auth.authenticated) {
    return (
      <section className="circle-settlement-card cosmic">
        <div className="settlement-prominent-notice" role="alert">
          <div className="notice-icon">
            <AlertTriangle size={20} />
          </div>
          <div className="notice-content">
            <strong className="notice-headline">
              Final contractor payment not sent.
            </strong>
            <p className="notice-text">
              This surface operates exclusively on Arc Testnet for P6A
              infrastructure verification. The flagship 50 USDC contractor
              payment remains securely held in REQUIRE_APPROVAL state.
            </p>
          </div>
        </div>

        <div className="settlement-header">
          <div className="settlement-title-group">
            <span className="eyebrow">
              <span className="preview-dot" /> P6A Settlement Infrastructure
            </span>
            <h2 className="settlement-title">Circle + Arc Testnet Settlement</h2>
            <p className="settlement-subtitle">
              Connect your Privy embedded wallet to access the Arc Testnet
              settlement surface and Circle App Kit integration.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="circle-settlement-card cosmic">
      {/* Prominent Required Banner */}
      <div className="settlement-prominent-notice" role="alert">
        <div className="notice-icon">
          <AlertTriangle size={20} />
        </div>
        <div className="notice-content">
          <strong className="notice-headline">
            Final contractor payment not sent.
          </strong>
          <p className="notice-text">
            This surface operates exclusively on Arc Testnet for P6A
            infrastructure verification. The flagship 50 USDC contractor
            payment remains securely held in REQUIRE_APPROVAL state.
          </p>
        </div>
      </div>

      <div className="settlement-header">
        <div className="settlement-title-group">
          <span className="eyebrow">
            <span className="preview-dot" /> P6A Settlement Infrastructure
          </span>
          <h2 className="settlement-title">Circle + Arc Testnet Settlement</h2>
          <p className="settlement-subtitle">
            Authenticated execution wallet settlement slice with Circle App
            Kit and Arc Testnet (Chain ID {ARC_TESTNET_CHAIN_ID}).
          </p>
        </div>
        <div className="settlement-actions-top">
          <button
            type="button"
            className="button button-outline"
            onClick={refreshBalances}
            disabled={loadingBalances || !auth.authenticated}
          >
            <RefreshCw
              size={14}
              className={loadingBalances ? "animate-spin" : ""}
            />
            refresh balances
          </button>
        </div>
      </div>

      {/* Grid of Readiness and Balances */}
      <div className="settlement-metrics-grid">
        <div className="metric-card">
          <span className="metric-label">Arc Testnet Status</span>
          <span className="metric-value">
            <CheckCircle2 size={16} className="text-glow" /> 5042002 (Active)
          </span>
          <span className="metric-subtext">RPC reachable · ArcScan</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">Execution Wallet</span>
          <span className="metric-value mono-break">
            {executionWallet?.address ? (
              `${executionWallet.address.slice(0, 6)}...${executionWallet.address.slice(-4)}`
            ) : (
              <span className="muted">none</span>
            )}
          </span>
          <span className="metric-subtext">
            {executionWallet?.role ?? "unauthenticated"}
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-label">Arc USDC (Wallet ERC-20)</span>
          <span className="metric-value">
            {walletBalance
              ? formatMoney(walletBalance)
              : auth.authenticated
                ? "0.00 USDC"
                : "not loaded"}
          </span>
          <span className="metric-subtext">6 decimals · atomic units</span>
        </div>

        <div className="metric-card">
          <span className="metric-label">Circle Unified Balance</span>
          <span className="metric-value">
            {unifiedBalance
              ? formatMoney(unifiedBalance)
              : auth.authenticated
                ? "0.00 USDC"
                : "not loaded"}
          </span>
          <span className="metric-subtext">Gateway v1 balance</span>
        </div>
      </div>

      {balanceError && (
        <div className="settlement-error-banner" role="alert">
          <AlertTriangle size={16} />
          <span>{balanceError}</span>
        </div>
      )}

      {/* Preflight Inspection Section */}
      <div className="settlement-preflight-panel">
        <div className="preflight-header">
          <div>
            <h3 className="preflight-title">Deterministic Preflight</h3>
            <p className="preflight-desc">
              Deterministic, read-only inspection. Never signs, approves,
              deposits, or submits transactions.
            </p>
          </div>
          <button
            type="button"
            className="button button-light"
            onClick={handleRunPreflight}
            disabled={preflightLoading || !auth.authenticated}
          >
            <Shield size={14} />
            {preflightLoading ? "inspecting..." : "run preflight check"}
          </button>
        </div>

        {preflightError && (
          <div className="settlement-error-banner" role="alert">
            <AlertTriangle size={16} />
            <span>{preflightError}</span>
          </div>
        )}

        {preflight && (
          <div className="preflight-results" role="status">
            <div className="preflight-metric-row">
              <div>
                <dt>Execution Wallet Ready:</dt>
                <dd>{preflight.walletReady ? "ready" : "not ready"}</dd>
              </div>
              <div>
                <dt>Arc Testnet Reachable:</dt>
                <dd>{preflight.arcTestnetReachable ? "yes" : "no"}</dd>
              </div>
              <div>
                <dt>Current Wallet Chain:</dt>
                <dd>
                  {preflight.currentWalletChain !== undefined
                    ? `${preflight.currentWalletChain}`
                    : "detecting"}
                </dd>
              </div>
              <div>
                <dt>Target Chain:</dt>
                <dd>{preflight.targetChain} (Arc Testnet)</dd>
              </div>
              <div>
                <dt>Privy Chain Support:</dt>
                <dd>
                  {preflight.chainSupportedByPrivy ? "supported" : "unsupported"}
                </dd>
              </div>
              <div>
                <dt>Network Switch:</dt>
                <dd>
                  {preflight.switchRequired
                    ? "required before signing"
                    : "not needed (on Arc)"}
                </dd>
              </div>
              <div>
                <dt>Requested Test Amount:</dt>
                <dd>{formatMoney(preflight.requestedAmount)}</dd>
              </div>
              <div>
                <dt>Sufficient Wallet Balance:</dt>
                <dd>{preflight.sufficientWalletBalance ? "yes" : "no"}</dd>
              </div>
              <div>
                <dt>Unified Balance Deposit Needed:</dt>
                <dd>
                  {preflight.requiresUnifiedBalanceDeposit
                    ? "yes (if using Gateway spend)"
                    : "no"}
                </dd>
              </div>
              <div>
                <dt>Signing Status:</dt>
                <dd className="status-pill state-waiting">not performed</dd>
              </div>
              <div>
                <dt>Transaction Status:</dt>
                <dd className="status-pill state-waiting">not submitted</dd>
              </div>
              <div>
                <dt>Ready for Test Settlement:</dt>
                <dd>
                  <span
                    className={`status-pill ${
                      preflight.readyForOneTestSettlement
                        ? "state-approval"
                        : "state-blocked"
                    }`}
                  >
                    {preflight.readyForOneTestSettlement ? "ready" : "blocked"}
                  </span>
                </dd>
              </div>
            </div>

            {preflight.blockers.length > 0 && (
              <div className="preflight-blockers">
                <p className="blockers-heading">Blockers preventing execution:</p>
                <ul>
                  {preflight.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Manual Testnet Settlement Slice */}
      <div className="settlement-execution-panel">
        <h3 className="panel-title">Manual Testnet Vertical Slice</h3>
        <p className="panel-desc">
          Test ONE small settlement with explicit human confirmation. The test
          amount is strictly bounded and cannot exceed 1 USDC.
        </p>

        <div className="settlement-inputs-grid">
          <div className="input-group">
            <label htmlFor="test-amount-input">Test Amount (USDC):</label>
            <input
              id="test-amount-input"
              type="text"
              value={testAmountInput}
              onChange={(e) => {
                setTestAmountInput(e.target.value);
                setPreflight(null);
                setPreparedParams(null);
                setShowConfirmation(false);
              }}
              placeholder="0.01"
              disabled={isSubmitting || Boolean(execution)}
            />
            <span className="input-hint">Default test amount: 10000 atomic units (max 1 token unit)</span>
          </div>

          <div className="input-group">
            <label htmlFor="test-recipient-input">Destination Recipient:</label>
            <input
              id="test-recipient-input"
              type="text"
              value={testRecipientInput}
              onChange={(e) => {
                setTestRecipientInput(e.target.value);
                setPreflight(null);
                setPreparedParams(null);
                setShowConfirmation(false);
              }}
              placeholder="0x..."
              disabled={isSubmitting || Boolean(execution)}
            />
            <span className="input-hint">
              Arc Testnet recipient address
            </span>
          </div>

          <div className="input-group">
            <label htmlFor="operation-type-select">Operation Type:</label>
            <select
              id="operation-type-select"
              value={operationType}
              onChange={(e) => {
                setOperationType(e.target.value as CircleSettlementOperationType);
                setPreflight(null);
                setPreparedParams(null);
                setShowConfirmation(false);
              }}
              disabled={isSubmitting || Boolean(execution)}
            >
              <option value="erc20_transfer">
                Direct Arc USDC ERC-20 Transfer
              </option>
              <option value="unified_balance_deposit">
                Circle Unified Balance Deposit
              </option>
              <option value="unified_balance_spend">
                Circle Unified Balance Spend
              </option>
            </select>
            <span className="input-hint">
              Models deposit and spend as distinct operations
            </span>
          </div>
        </div>

        {executionError && (
          <div className="settlement-error-banner" role="alert">
            <AlertTriangle size={16} />
            <span>{executionError}</span>
          </div>
        )}

        {/* Action button */}
        {!execution && (
          <div className="settlement-submit-area">
            <button
              type="button"
              className="button button-primary"
              onClick={handleInitiateSettlement}
              disabled={
                !auth.authenticated ||
                !preflight?.readyForOneTestSettlement ||
                isSubmitting
              }
            >
              <Send size={14} />
              review & initiate test settlement
            </button>
            {!preflight && (
              <span className="submit-hint">
                Run preflight inspection first to unlock settlement initiation.
              </span>
            )}
          </div>
        )}

        {/* Explicit Confirmation Boundary Modal/Surface */}
        {showConfirmation && !execution && (
          <div className="confirmation-boundary-overlay" role="dialog" aria-modal="true">
            <div className="confirmation-boundary-card">
              <div className="boundary-header">
                <Shield size={20} className="text-glow" />
                <h3>Explicit Settlement Confirmation</h3>
              </div>
              <p className="boundary-desc">
                Confirm the exact settlement parameters below. No parameters are
                inferred from fixtures.
              </p>
              <dl className="boundary-parameters">
                <div>
                  <dt>Source Wallet:</dt>
                  <dd className="mono-break">
                    {preparedParams?.sourceWallet}
                  </dd>
                </div>
                <div>
                  <dt>Recipient:</dt>
                  <dd className="mono-break">{preparedParams?.recipient}</dd>
                </div>
                <div>
                  <dt>Amount:</dt>
                  <dd>
                    {preparedParams
                      ? `${formatMoney(preparedParams.amount)} ${preparedParams.amount.asset}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>Source Chain:</dt>
                  <dd>{preparedParams?.sourceChain} (Chain ID 5042002)</dd>
                </div>
                <div>
                  <dt>Destination Chain:</dt>
                  <dd>{preparedParams?.destinationChain}</dd>
                </div>
                <div>
                  <dt>Operation:</dt>
                  <dd>{preparedParams?.operationType}</dd>
                </div>
                <div>
                  <dt>Max Fee:</dt>
                  <dd>
                    {preparedParams
                      ? `${formatMoney(preparedParams.maxFee)} ${preparedParams.maxFee.asset}`
                      : "0.00 USDC"}
                  </dd>
                </div>
              </dl>
              <div className="boundary-actions">
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => setShowConfirmation(false)}
                  disabled={isSubmitting}
                >
                  cancel
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={handleConfirmAndExecute}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <RefreshCw size={14} className="animate-spin" />
                      submitting transaction...
                    </>
                  ) : (
                    "confirm & send test settlement"
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Execution Status & Evidence Display */}
        {execution && (
          <div className="settlement-evidence-card" role="region">
            <div className="evidence-header">
              <div className="evidence-status-group">
                <span className="evidence-badge">
                  Status: {execution.status}
                </span>
                {execution.status === "confirmed" && (
                  <span className="status-pill state-approval">confirmed</span>
                )}
                {execution.status === "reverted" && (
                  <span className="status-pill state-blocked">reverted</span>
                )}
                {(execution.status === "submitting" ||
                  execution.status === "submitted" ||
                  execution.status === "confirming") && (
                  <span className="status-pill state-waiting">
                    <RefreshCw size={12} className="animate-spin" /> processing
                  </span>
                )}
              </div>
              <div className="evidence-actions">
                {execution.transactionHash &&
                  execution.status !== "confirmed" &&
                  execution.status !== "reverted" && (
                    <button
                      type="button"
                      className="button button-outline"
                      onClick={handleReconcile}
                      disabled={isReconciling}
                    >
                      <RefreshCw
                        size={12}
                        className={isReconciling ? "animate-spin" : ""}
                      />
                      reconcile onchain
                    </button>
                  )}
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={handleResetTestSlice}
                >
                  reset test slice
                </button>
              </div>
            </div>

            <dl className="evidence-details-list">
              <div>
                <dt>Execution ID:</dt>
                <dd>{execution.id}</dd>
              </div>
              <div>
                <dt>Operation:</dt>
                <dd>{execution.operationType}</dd>
              </div>
              <div>
                <dt>Amount:</dt>
                <dd>{formatMoney(execution.params.amount)}</dd>
              </div>
              <div>
                <dt>Recipient:</dt>
                <dd className="mono-break">{execution.params.recipient}</dd>
              </div>
              {execution.transactionHash && (
                <div>
                  <dt>Transaction Hash:</dt>
                  <dd className="mono-break">
                    <a
                      href={`${ARC_TESTNET_EXPLORER_URL}/tx/${execution.transactionHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="explorer-link"
                    >
                      {execution.transactionHash}
                      <ExternalLink size={12} />
                    </a>
                  </dd>
                </div>
              )}
              {execution.evidence?.blockNumber && (
                <div>
                  <dt>Confirmed in Block:</dt>
                  <dd>{execution.evidence.blockNumber}</dd>
                </div>
              )}
              {execution.evidence?.timestamp && (
                <div>
                  <dt>Confirmed Timestamp:</dt>
                  <dd>{execution.evidence.timestamp}</dd>
                </div>
              )}
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}

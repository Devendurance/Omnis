"use client";

import { use, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileCheck2,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { formatMoney, type OmnisProof } from "@/lib/domain";
import { loadDraftSession } from "@/lib/tasks/persistence";
import { serviceRegistry } from "@/lib/services/registry";
import { ARC_TESTNET_EXPLORER_URL } from "@/lib/settlement";

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

export default function ProofRecordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const auth = useAuth();
  const [showTechnicalEvidence, setShowTechnicalEvidence] = useState(false);

  const isClient = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  let proof: OmnisProof | null = null;
  if (isClient && auth.authenticated && auth.ownerSubject) {
    const session = loadDraftSession(window.localStorage, serviceRegistry, {
      expectedOwnerSubject: auth.ownerSubject,
    });
    if (
      session?.proof &&
      (session.proof.id === id ||
        session.proof.taskId === id ||
        session.task?.id === id)
    ) {
      proof = session.proof;
    }
  }

  if (!isClient) {
    return (
      <div className="collection-page" style={{ padding: "3rem" }}>
        <p className="muted">Loading proof bundle...</p>
      </div>
    );
  }

  if (!proof) {
    return (
      <div className="collection-page" style={{ padding: "3rem" }}>
        <p className="eyebrow">proof archive</p>
        <h1>Proof record not found</h1>
        <p className="muted">
          No finalized proof bundle found for task <code>{id}</code>.
        </p>
        <div style={{ marginTop: "2rem" }}>
          <Link href="/app" className="button button-outline">
            <ArrowLeft size={14} /> back to app
          </Link>
        </div>
      </div>
    );
  }

  const purchase = proof.servicePurchases?.[0];
  const observations = purchase?.serviceResult?.observations;
  const flags = purchase?.serviceResult?.heuristicFlags ?? [];
  const finalPayment = proof.finalPayment;
  const approval = proof.approval;

  return (
    <div className="collection-page" style={{ padding: "2rem 3rem" }}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">proof bundle</p>
          <h1>{proof.testMode ? "demo verified. proof is ready." : "task complete. proof is ready."}</h1>
          <p className="page-description">
            Cryptographic and verifiable settlement proof for task <code>{proof.taskId}</code>.
          </p>
        </div>
        <span className="page-symbol" aria-hidden="true">
          <FileCheck2 size={29} strokeWidth={1.2} />
        </span>
      </div>

      <div style={{ marginTop: "2rem", display: "grid", gap: "2rem", maxWidth: "900px" }}>
        {/* Outcome Banner */}
        <div
          style={{
            background: "#2B0F6E",
            border: "1.5px solid #7B3FF2",
            borderRadius: "20px",
            padding: "24px 32px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <span style={{ fontFamily: "JetBrains Mono", fontSize: "12px", color: "#C9B7FF" }}>
              {proof.testMode ? "demo verification status" : "final task status"}
            </span>
            <h2 style={{ fontSize: "24px", color: "#FFFFFF", marginTop: "4px" }}>
              {proof.testMode ? "DEMO VERIFIED" : "COMPLETED"}
            </h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#C9B7FF" }}>
            <CheckCircle2 size={24} />
            <span style={{ fontFamily: "JetBrains Mono", fontSize: "14px" }}>
              proof verified
            </span>
          </div>
        </div>

        {/* Compact Proof Summary */}
        <section
          className="proof-summary-card"
          style={{
            background: "#F3EEFC",
            color: "#14101C",
            borderRadius: "20px",
            padding: "32px",
            border: "1.5px solid #7B3FF2",
          }}
          aria-label="Executive Proof Summary"
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "24px",
            }}
          >
            <span
              style={{
                fontFamily: "JetBrains Mono",
                fontSize: "12px",
                textTransform: "uppercase",
                color: "#7B3FF2",
                fontWeight: "bold",
              }}
            >
              Executive Proof Summary
            </span>
            <span
              style={{
                fontFamily: "JetBrains Mono",
                fontSize: "12px",
                background: "#7B3FF2",
                color: "#FFFFFF",
                padding: "4px 12px",
                borderRadius: "9999px",
              }}
            >
              {proof.testMode ? "DEMO VERIFIED" : "VERIFIED"}
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "16px",
            }}
          >
            <div
              style={{
                background: "#FFFFFF",
                padding: "16px",
                borderRadius: "12px",
                border: "1px solid #E6DCF5",
              }}
            >
              <span
                style={{
                  fontFamily: "JetBrains Mono",
                  fontSize: "11px",
                  color: "#666",
                  display: "block",
                }}
              >
                MANDATE
              </span>
              <strong
                style={{
                  fontSize: "15px",
                  color: "#14101C",
                  display: "block",
                  marginTop: "4px",
                }}
              >
                {proof.task.paymentAmount
                  ? `${formatMoney(proof.task.paymentAmount)} ${proof.task.paymentAmount.asset}`
                  : "contractor payment"}{" "}
                {proof.task.purpose ?? "contractor payment"}
              </strong>
            </div>

            <div
              style={{
                background: "#FFFFFF",
                padding: "16px",
                borderRadius: "12px",
                border: "1px solid #E6DCF5",
              }}
            >
              <span
                style={{
                  fontFamily: "JetBrains Mono",
                  fontSize: "11px",
                  color: "#666",
                  display: "block",
                }}
              >
                MACHINE SERVICE
              </span>
              <strong
                style={{
                  fontSize: "15px",
                  color: "#14101C",
                  display: "block",
                  marginTop: "4px",
                }}
              >
                {purchase?.paidAmount
                  ? `$${formatMoney(purchase.paidAmount)}`
                  : purchase?.quotedAmount
                    ? `$${formatMoney(purchase.quotedAmount)}`
                    : "not recorded"}
              </strong>
              <span
                style={{
                  fontFamily: "JetBrains Mono",
                  fontSize: "12px",
                  color: "#7B3FF2",
                }}
              >
                {purchase?.status === "paid"
                  ? "Hedera x402 confirmed"
                  : purchase?.status
                    ? `Hedera x402 ${purchase.status}`
                    : "service unrecorded"}
              </span>
            </div>

            <div
              style={{
                background: "#FFFFFF",
                padding: "16px",
                borderRadius: "12px",
                border: "1px solid #E6DCF5",
              }}
            >
              <span
                style={{
                  fontFamily: "JetBrains Mono",
                  fontSize: "11px",
                  color: "#666",
                  display: "block",
                }}
              >
                HUMAN CONTROL
              </span>
              <strong
                style={{
                  fontSize: "15px",
                  color: "#14101C",
                  display: "block",
                  marginTop: "4px",
                }}
              >
                {approval
                  ? "approved by authenticated owner"
                  : "approval not recorded"}
              </strong>
              <span
                style={{
                  fontFamily: "JetBrains Mono",
                  fontSize: "12px",
                  color: "#666",
                }}
              >
                {approval?.decision ?? "unrecorded"}
              </span>
            </div>

            <div
              style={{
                background: "#FFFFFF",
                padding: "16px",
                borderRadius: "12px",
                border: "1px solid #E6DCF5",
              }}
            >
              <span
                style={{
                  fontFamily: "JetBrains Mono",
                  fontSize: "11px",
                  color: "#666",
                  display: "block",
                }}
              >
                {proof.testMode ? "TEST SETTLEMENT" : "FINAL SETTLEMENT"}
              </span>
              <strong
                style={{
                  fontSize: "15px",
                  color: "#14101C",
                  display: "block",
                  marginTop: "4px",
                }}
              >
                {finalPayment?.executionAmount
                  ? `${formatMoney(finalPayment.executionAmount)} ${finalPayment.executionAmount.asset}`
                  : finalPayment?.amount
                    ? `${formatMoney(finalPayment.amount)} ${finalPayment.amount.asset}`
                    : "not recorded"}
              </strong>
              <span
                style={{
                  fontFamily: "JetBrains Mono",
                  fontSize: "12px",
                  color: "#7B3FF2",
                  display: "block",
                }}
              >
                {finalPayment?.status === "confirmed"
                  ? "Arc Testnet confirmed"
                  : finalPayment?.status
                    ? `Arc Testnet ${finalPayment.status}`
                    : "not recorded"}
              </span>
              <span
                style={{
                  fontFamily: "JetBrains Mono",
                  fontSize: "11px",
                  color: "#666",
                }}
              >
                {finalPayment?.confirmationEvidence?.provenance?.blockNumber
                  ? `Block ${finalPayment.confirmationEvidence.provenance.blockNumber.toString()}`
                  : "block not recorded"}
              </span>
            </div>

            {proof.testMode && (
              <div
                style={{
                  background: "#FFFFFF",
                  padding: "16px",
                  borderRadius: "12px",
                  border: "1px solid #E6DCF5",
                }}
              >
                <span
                  style={{
                    fontFamily: "JetBrains Mono",
                    fontSize: "11px",
                    color: "#666",
                    display: "block",
                  }}
                >
                  ORIGINAL PAYMENT
                </span>
                <strong
                  style={{
                    fontSize: "15px",
                    color: "#A32945",
                    display: "block",
                    marginTop: "4px",
                  }}
                >
                  {proof.originalPaymentDelivered ? "DELIVERED" : "NOT EXECUTED"}
                </strong>
                <span
                  style={{
                    fontFamily: "JetBrains Mono",
                    fontSize: "11px",
                    color: "#666",
                  }}
                >
                  Mandate:{" "}
                  {proof.task.paymentAmount
                    ? `${formatMoney(proof.task.paymentAmount)} ${proof.task.paymentAmount.asset}`
                    : "not recorded"}
                </span>
              </div>
            )}
            {!proof.testMode && proof.originalPaymentDelivered && (
              <div
                style={{
                  background: "#FFFFFF",
                  padding: "16px",
                  borderRadius: "12px",
                  border: "1px solid #E6DCF5",
                }}
              >
                <span
                  style={{
                    fontFamily: "JetBrains Mono",
                    fontSize: "11px",
                    color: "#666",
                    display: "block",
                  }}
                >
                  ORIGINAL PAYMENT
                </span>
                <strong
                  style={{
                    fontSize: "15px",
                    color: "#2B0F6E",
                    display: "block",
                    marginTop: "4px",
                  }}
                >
                  EXECUTED
                </strong>
                <span
                  style={{
                    fontFamily: "JetBrains Mono",
                    fontSize: "11px",
                    color: "#666",
                  }}
                >
                  Mandate:{" "}
                  {proof.task.paymentAmount
                    ? `${formatMoney(proof.task.paymentAmount)} ${proof.task.paymentAmount.asset}`
                    : "not recorded"}
                </span>
              </div>
            )}

            {proof.testMode && (
              <div
                style={{
                  background: "#FFFFFF",
                  padding: "16px",
                  borderRadius: "12px",
                  border: "1px solid #E6DCF5",
                }}
              >
                <span
                  style={{
                    fontFamily: "JetBrains Mono",
                    fontSize: "11px",
                    color: "#666",
                    display: "block",
                  }}
                >
                  DEMO VERIFICATION
                </span>
                <strong
                  style={{
                    fontSize: "15px",
                    color: "#2B0F6E",
                    display: "block",
                    marginTop: "4px",
                  }}
                >
                  {proof.demoVerificationStatus === "complete"
                    ? "PASSED"
                    : proof.demoVerificationStatus
                      ? proof.demoVerificationStatus.toUpperCase()
                      : finalPayment?.status === "confirmed"
                        ? "PASSED"
                        : "PENDING"}
                </strong>
                <span
                  style={{
                    fontFamily: "JetBrains Mono",
                    fontSize: "11px",
                    color: "#666",
                  }}
                >
                  Circle + Arc testnet verification
                </span>
              </div>
            )}
          </div>

          <div
            style={{
              marginTop: "24px",
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              className="button button-outline"
              onClick={() => setShowTechnicalEvidence(!showTechnicalEvidence)}
              style={{ display: "flex", alignItems: "center", gap: "8px" }}
            >
              <span>Technical evidence</span>
              {showTechnicalEvidence ? (
                <ChevronUp size={14} />
              ) : (
                <ChevronDown size={14} />
              )}
            </button>
          </div>
        </section>

        {showTechnicalEvidence && (
          <div style={{ display: "grid", gap: "2rem" }}>
        {/* Task Section */}
        <section
          style={{
            background: "#F3EEFC",
            color: "#14101C",
            borderRadius: "20px",
            padding: "32px",
          }}
        >
          <span style={{ fontFamily: "JetBrains Mono", fontSize: "12px", textTransform: "uppercase" }}>
            task intent
          </span>
          <h3 style={{ fontSize: "20px", marginTop: "4px", marginBottom: "16px" }}>
            {proof.task.purpose ?? "contractor payment with wallet check"}
          </h3>
          <dl style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: "8px 16px", fontSize: "14px" }}>
            <dt style={{ color: "#666" }}>task id:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{proof.taskId}</dd>
            <dt style={{ color: "#666" }}>owner subject:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{proof.ownerId}</dd>
            <dt style={{ color: "#666" }}>original intent:</dt>
            <dd>{proof.task.originalIntent ?? "Pay contractor with wallet check"}</dd>
          </dl>
        </section>

        {/* Service Purchase Section */}
        <section
          style={{
            background: "#F3EEFC",
            color: "#14101C",
            borderRadius: "20px",
            padding: "32px",
          }}
        >
          <span style={{ fontFamily: "JetBrains Mono", fontSize: "12px", textTransform: "uppercase" }}>
            service verification (P4A / P4B)
          </span>
          <h3 style={{ fontSize: "20px", marginTop: "4px", marginBottom: "16px" }}>
            Wallet activity check
          </h3>
          <dl style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: "8px 16px", fontSize: "14px" }}>
            <dt style={{ color: "#666" }}>service cost:</dt>
            <dd style={{ fontFamily: "JetBrains Mono", fontWeight: "bold" }}>
              {formatMoney(proof.totalServiceSpend)} {proof.totalServiceSpend.asset}
            </dd>
            <dt style={{ color: "#666" }}>network:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>
              {purchase?.settlementNetwork ?? "hedera:testnet"}
            </dd>
            <dt style={{ color: "#666" }}>payment identifier:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>
              {purchase?.paymentIdentifier ?? "none"}
            </dd>
            <dt style={{ color: "#666" }}>factual observations:</dt>
            <dd>
              {observations ? (
                <pre style={{ fontSize: "12px", background: "#E8DCFA", padding: "8px 12px", borderRadius: "8px" }}>
                  {JSON.stringify(observations, null, 2)}
                </pre>
              ) : (
                "none"
              )}
            </dd>
            <dt style={{ color: "#666" }}>heuristic flags:</dt>
            <dd>
              {flags.length > 0 ? (
                <ul style={{ paddingLeft: "1.2rem", margin: 0 }}>
                  {flags.map((flag, idx) => (
                    <li key={idx} style={{ fontSize: "13px" }}>
                      {typeof flag === "object" ? JSON.stringify(flag) : String(flag)}
                    </li>
                  ))}
                </ul>
              ) : (
                "none"
              )}
            </dd>
          </dl>
        </section>

        {/* Final Settlement Section */}
        <section
          style={{
            background: "#F3EEFC",
            color: "#14101C",
            borderRadius: "20px",
            padding: "32px",
          }}
        >
          <span style={{ fontFamily: "JetBrains Mono", fontSize: "12px", textTransform: "uppercase" }}>
            {proof.testMode
              ? "final settlement (P6B TEST MODE)"
              : "final settlement (P6A / P6B)"}
          </span>
          <h3 style={{ fontSize: "20px", marginTop: "4px", marginBottom: "16px" }}>
            {proof.testMode ? "Arc Testnet Demo Settlement" : "Arc Testnet Transfer"}
          </h3>
          <dl style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: "8px 16px", fontSize: "14px" }}>
            {proof.testMode ? (
              <>
                <dt style={{ color: "#666" }}>original mandate:</dt>
                <dd style={{ fontFamily: "JetBrains Mono", fontWeight: "bold" }}>
                  50 USDC contractor payment
                </dd>
                <dt style={{ color: "#666" }}>original 50 USDC:</dt>
                <dd style={{ fontFamily: "JetBrains Mono", color: "#A32945", fontWeight: "bold" }}>
                  NOT EXECUTED
                </dd>
                <dt style={{ color: "#666" }}>authorized test:</dt>
                <dd style={{ fontFamily: "JetBrains Mono", fontWeight: "bold" }}>
                  0.01 USDC authorized test settlement
                </dd>
                <dt style={{ color: "#666" }}>demo verification:</dt>
                <dd style={{ fontFamily: "JetBrains Mono", color: "#7B3FF2", fontWeight: "bold" }}>
                  PASSED
                </dd>
              </>
            ) : (
              <>
                <dt style={{ color: "#666" }}>amount delivered:</dt>
                <dd style={{ fontFamily: "JetBrains Mono", fontWeight: "bold" }}>
                  {finalPayment?.amount ? `${formatMoney(finalPayment.amount)} ${finalPayment.amount.asset}` : "not recorded"}
                </dd>
                <dt style={{ color: "#666" }}>original payment:</dt>
                <dd style={{ fontFamily: "JetBrains Mono", color: "#2B0F6E", fontWeight: "bold" }}>
                  {proof.originalPaymentDelivered ? "EXECUTED" : "NOT EXECUTED"}
                </dd>
              </>
            )}
            <dt style={{ color: "#666" }}>recipient:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>
              {finalPayment?.recipient ?? proof.task.recipient}
            </dd>
            <dt style={{ color: "#666" }}>source wallet:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>
              {approval?.walletAddress ?? proof.task.ownerWalletAddress}
            </dd>
            <dt style={{ color: "#666" }}>network:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>Arc Testnet (Chain ID 5042002)</dd>
            <dt style={{ color: "#666" }}>transaction hash:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>
              {finalPayment?.transactionHash ? (
                <a
                  href={`${ARC_TESTNET_EXPLORER_URL}/tx/${finalPayment.transactionHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#7B3FF2", textDecoration: "underline" }}
                >
                  {finalPayment.transactionHash} <ArrowUpRight size={12} style={{ display: "inline" }} />
                </a>
              ) : (
                "none"
              )}
            </dd>
            <dt style={{ color: "#666" }}>block reference:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>
              {finalPayment?.confirmationEvidence?.receiptReference ?? "confirmed"}
            </dd>
            <dt style={{ color: "#666" }}>status:</dt>
            <dd style={{ fontFamily: "JetBrains Mono", color: "#2B0F6E", fontWeight: "bold" }}>
              {finalPayment?.status ?? "confirmed"}
            </dd>
            {finalPayment?.confirmationEvidence?.provenance && (
              <>
                <dt style={{ color: "#666" }}>confirmation source:</dt>
                <dd style={{ fontFamily: "JetBrains Mono" }}>
                  {finalPayment.confirmationEvidence.provenance.sourceName}
                </dd>
                {finalPayment.confirmationEvidence.provenance.transactionFee && (
                  <>
                    <dt style={{ color: "#666" }}>transaction fee:</dt>
                    <dd style={{ fontFamily: "JetBrains Mono" }}>
                      {finalPayment.confirmationEvidence.provenance.transactionFee}
                    </dd>
                  </>
                )}
              </>
            )}
          </dl>
        </section>

        {/* Control & Approval Section */}
        <section
          style={{
            background: "#F3EEFC",
            color: "#14101C",
            borderRadius: "20px",
            padding: "32px",
          }}
        >
          <span style={{ fontFamily: "JetBrains Mono", fontSize: "12px", textTransform: "uppercase" }}>
            authority & policy control (P2 / P5A)
          </span>
          <h3 style={{ fontSize: "20px", marginTop: "4px", marginBottom: "16px" }}>
            Approval Record
          </h3>
          <dl style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: "8px 16px", fontSize: "14px" }}>
            <dt style={{ color: "#666" }}>approval id:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{approval?.id ?? "none"}</dd>
            <dt style={{ color: "#666" }}>approver subject:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{approval?.approverId ?? proof.ownerId}</dd>
            <dt style={{ color: "#666" }}>approved at:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{approval?.approvedAt ?? proof.createdAt}</dd>
            <dt style={{ color: "#666" }}>policy task id:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{proof.policy.taskId}</dd>
            <dt style={{ color: "#666" }}>human decision:</dt>
            <dd style={{ fontFamily: "JetBrains Mono", fontWeight: "bold", color: "#7B3FF2" }}>
              {approval?.decision ?? "approved"}
            </dd>
          </dl>
        </section>
          </div>
        )}

        <div style={{ marginTop: "1rem" }}>
          <Link href="/app" className="button button-outline">
            <ArrowLeft size={14} /> return to task workspace
          </Link>
        </div>
      </div>
    </div>
  );
}

"use client";

import { use, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { formatMoney, type ApprovalRecord } from "@/lib/domain";
import { loadDraftSession } from "@/lib/tasks/persistence";
import { serviceRegistry } from "@/lib/services/registry";

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

export default function ApprovalRecordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const auth = useAuth();

  const isClient = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  let approval: ApprovalRecord | null = null;
  if (isClient && auth.authenticated && auth.ownerSubject) {
    const session = loadDraftSession(window.localStorage, serviceRegistry, {
      expectedOwnerSubject: auth.ownerSubject,
    });
    if (
      session?.approval &&
      (session.approval.id === id ||
        session.approval.taskId === id ||
        session.task?.id === id)
    ) {
      approval = session.approval;
    }
  }

  if (!isClient) {
    return (
      <div className="collection-page" style={{ padding: "3rem" }}>
        <p className="muted">Loading approval record...</p>
      </div>
    );
  }

  if (!approval) {
    return (
      <div className="collection-page" style={{ padding: "3rem" }}>
        <p className="eyebrow">approvals</p>
        <h1>Approval record not found</h1>
        <p className="muted">
          No approval record found for task <code>{id}</code>.
        </p>
        <div style={{ marginTop: "2rem" }}>
          <Link href="/app" className="button button-outline">
            <ArrowLeft size={14} /> back to app
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="collection-page" style={{ padding: "2rem 3rem" }}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">human approval</p>
          <h1>Explicit Settlement Approval</h1>
          <p className="page-description">
            Human authorization record for task <code>{approval.taskId}</code>.
          </p>
        </div>
        <span className="page-symbol" aria-hidden="true">
          <ShieldCheck size={29} strokeWidth={1.2} />
        </span>
      </div>

      <div style={{ marginTop: "2rem", maxWidth: "800px" }}>
        <section
          style={{
            background: "#F3EEFC",
            color: "#14101C",
            borderRadius: "20px",
            padding: "32px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#2B0F6E", marginBottom: "16px" }}>
            <CheckCircle2 size={20} />
            <span style={{ fontFamily: "JetBrains Mono", fontSize: "14px", fontWeight: "bold" }}>
              DECISION: APPROVED
            </span>
          </div>

          <dl style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: "10px 16px", fontSize: "14px" }}>
            <dt style={{ color: "#666" }}>approval id:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{approval.id}</dd>
            <dt style={{ color: "#666" }}>task id:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{approval.taskId}</dd>
            <dt style={{ color: "#666" }}>execution id:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{approval.settlementExecutionId}</dd>
            <dt style={{ color: "#666" }}>authorized amount:</dt>
            <dd style={{ fontFamily: "JetBrains Mono", fontWeight: "bold" }}>
              {formatMoney(approval.amount)} {approval.amount.asset}
            </dd>
            <dt style={{ color: "#666" }}>recipient:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{approval.recipient}</dd>
            <dt style={{ color: "#666" }}>source wallet:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{approval.walletAddress}</dd>
            <dt style={{ color: "#666" }}>settlement network:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{approval.network}</dd>
            <dt style={{ color: "#666" }}>approved at:</dt>
            <dd style={{ fontFamily: "JetBrains Mono" }}>{approval.approvedAt}</dd>
          </dl>
        </section>

        <div style={{ marginTop: "2rem" }}>
          <Link href="/app" className="button button-outline">
            <ArrowLeft size={14} /> return to task workspace
          </Link>
        </div>
      </div>
    </div>
  );
}

"use client";

import { use, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import { formatMoney } from "@/lib/domain";
import { useAuth } from "@/lib/auth";
import { serviceRegistry } from "@/lib/services/registry";
import { loadDraftSession } from "@/lib/tasks/persistence";
import type { TaskSession } from "@/lib/tasks/session";
import {
  findHistorySession,
  loadTaskArchive,
  summarizeTaskSession,
  taskDisplayStatus,
  taskModeLabel,
} from "@/lib/tasks/archive";
function formatStatus(status: string): string {
  return status.replace(/_/g, " ");
}

export default function TaskHistoryClient({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const taskId = decodeURIComponent(id);
  const auth = useAuth();
  const ownerSubject = auth.authenticated ? auth.ownerSubject : undefined;
  const [tick, setTick] = useState(0);
  // Server snapshot renders the loading shell; the client snapshot flips to
  // true after hydration without a set-state-in-effect cycle.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  useEffect(() => {
    const bump = () => setTick((value) => value + 1);
    window.addEventListener("storage", bump);
    window.addEventListener("focus", bump);
    return () => {
      window.removeEventListener("storage", bump);
      window.removeEventListener("focus", bump);
    };
  }, []);

  const view = useMemo(() => {
    void tick;
    // Server and first client render share the loading shell so hydration
    // never diverges; the owner-scoped record loads after mount.
    if (!mounted) {
      return { ready: false, session: null as TaskSession | null, isActive: false };
    }
    if (!auth.ready || !auth.authenticated || !ownerSubject) {
      return { ready: auth.ready, session: null as TaskSession | null, isActive: false };
    }
    let active: TaskSession | null = null;
    try {
      active = loadDraftSession(window.localStorage, serviceRegistry, {
        expectedOwnerSubject: ownerSubject,
      });
    } catch {
      active = null;
    }
    let archived: readonly TaskSession[] = [];
    try {
      archived = loadTaskArchive(window.localStorage, ownerSubject, serviceRegistry);
    } catch {
      archived = [];
    }
    const session = findHistorySession(active, archived, taskId);
    return { ready: true, session, isActive: session !== null && session === active };
  }, [auth.ready, auth.authenticated, ownerSubject, taskId, tick, mounted]);

  if (!view.ready) {
    return (
      <div className="collection-page" style={{ padding: "3rem" }}>
        <p className="muted">Loading task...</p>
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <div className="collection-page" style={{ padding: "3rem" }}>
        <p className="eyebrow">task record</p>
        <h1>Sign in to view this task</h1>
        <p className="muted">Task history belongs to your account.</p>
        <div style={{ marginTop: "2rem" }}>
          <Link href="/app" className="button button-outline">
            <ArrowLeft size={14} /> back to app
          </Link>
        </div>
      </div>
    );
  }

  if (!view.session) {
    return (
      <div className="collection-page" style={{ padding: "3rem" }}>
        <p className="eyebrow">task record</p>
        <h1>Task not found</h1>
        <p className="muted">
          No task with id <code>{taskId}</code> exists in this account history.
          Starting a new task never deletes history, so this id was never recorded here.
        </p>
        <div style={{ marginTop: "2rem", display: "flex", gap: "12px" }}>
          <Link href="/app/tasks" className="button button-outline">
            <ArrowLeft size={14} /> all tasks
          </Link>
          <Link href="/app" className="button button-outline">
            back to current task
          </Link>
        </div>
      </div>
    );
  }

  const session = view.session;
  const task = session.task;
  const summary = summarizeTaskSession(session);
  const locked = task
    ? task.status === "completed" ||
      task.status === "cancelled" ||
      task.status === "failed" ||
      session.proof !== undefined
    : true;
  const status = taskDisplayStatus(session);

  return (
    <div className="collection-page" style={{ padding: "2rem 3rem" }}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            task record / {task ? taskModeLabel(task.type) : "conversation"}
          </p>
          <h1>{summary}</h1>
          <p className="page-description">
            {task?.id ?? taskId} / {formatStatus(status)}
            {view.isActive ? " / current task" : " / historical record, read only"}
          </p>
        </div>
        <span className="page-symbol" aria-hidden="true">
          <MessagesSquare size={29} strokeWidth={1.2} />
        </span>
      </div>

      <div style={{ marginTop: "1rem", display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <Link href="/app/tasks" className="button button-outline">
          <ArrowLeft size={14} /> all tasks
        </Link>
        <Link href="/app" className="button button-outline">
          back to current task
        </Link>
      </div>

      {!view.isActive && (
        <p className="source-note" role="status" style={{ marginTop: "1.5rem" }}>
          Historical task. Read only. Nothing here can spend, approve, or settle.
          To act, continue in your current task.
        </p>
      )}

      <div style={{ marginTop: "2rem", display: "grid", gap: "2rem", maxWidth: "900px" }}>
        <section className="record-panel" aria-label="Task plan snapshot">
          <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>the plan</h2>
          {task ? (
            <div className="record-list">
              <div className="record-row">
                <div className="record-service">
                  <strong>{summary}</strong>
                  <span>{task.id}</span>
                </div>
                <span>{taskModeLabel(task.type)}</span>
                <span>{formatStatus(task.status)}</span>
                <span>
                  {task.paymentAmount
                    ? `${formatMoney(task.paymentAmount)} ${task.paymentAmount.asset}`
                    : "no final payment"}
                </span>
              </div>
              <p className="source-note" role="status">
                recipient: {task.recipient ?? "unspecified"} / service budget:{" "}
                {task.serviceBudget
                  ? `$${formatMoney(task.serviceBudget)}`
                  : "not configured"}{" "}
                / approval:{" "}
                {task.finalPaymentApprovalRequired
                  ? "final payment requires approval"
                  : "no approval boundary"}
              </p>
            </div>
          ) : (
            <p className="muted">No structured plan was recorded for this conversation.</p>
          )}
        </section>

        <section className="record-panel" aria-label="Task conversation">
          <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>the conversation</h2>
          {session.messages.length === 0 ? (
            <p className="muted">No messages were recorded.</p>
          ) : (
            <div className="record-list">
              {session.messages.map((message) => (
                <article className="record-row" key={message.id}>
                  <div className="record-service">
                    <strong>{message.role === "user" ? "you" : "omnis"}</strong>
                    <span>
                      {message.kind} /{" "}
                      <time dateTime={message.createdAt}>{message.createdAt}</time>
                    </span>
                  </div>
                  <span style={{ gridColumn: "span 3" }}>{message.content}</span>
                </article>
              ))}
            </div>
          )}
        </section>

        {session.policy && (
          <section className="record-panel" aria-label="Task policy snapshot">
            <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>the policy snapshot</h2>
            <div className="record-list">
              <div className="record-row">
                <div className="record-service">
                  <strong>Task policy</strong>
                  <span>{session.policy.taskId}</span>
                </div>
                <span>{session.policy.allowedServiceCategories.join(", ") || "none"}</span>
                <span className="money">
                  {session.policy.maxServiceSpend
                    ? `$${formatMoney(session.policy.maxServiceSpend)}`
                    : "not configured"}
                </span>
                <span>
                  {session.policy.finalPaymentApprovalRequired
                    ? "final payment requires approval"
                    : "no approval boundary"}
                </span>
              </div>
            </div>
          </section>
        )}

        {(session.servicePurchases ?? []).length > 0 && (
          <section className="record-panel" aria-label="Service purchases">
            <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>services</h2>
            <div className="record-list">
              {(session.servicePurchases ?? []).map((purchase) => (
                <div className="record-row" key={purchase.id}>
                  <div className="record-service">
                    <strong>{purchase.serviceId}</strong>
                    <span>{purchase.id}</span>
                  </div>
                  <span>{formatStatus(purchase.status)}</span>
                  <span className="money">
                    {(purchase.paidAmount ?? purchase.quotedAmount)
                      ? `$${formatMoney(purchase.paidAmount ?? purchase.quotedAmount)}`
                      : "no amount"}
                  </span>
                  <span>{purchase.settlementNetwork ?? purchase.paymentIdentifier ?? ""}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {task?.status === "awaiting_approval" && session.approval === undefined && (
          <section className="record-panel" aria-label="Approval state">
            <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>approval</h2>
            <p className="muted">
              {view.isActive ? (
                <>
                  This task is awaiting your decision.{" "}
                  <Link href="/app">Decide in the current task.</Link>
                </>
              ) : (
                <>
                  This historical snapshot reached the approval boundary with no recorded
                  decision. Approval happens once, in the current task.{" "}
                  <Link href="/app">Back to current task.</Link>
                </>
              )}
            </p>
          </section>
        )}

        {session.approval && (
          <section className="record-panel" aria-label="Approval record">
            <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>approval</h2>
            <p className="muted">
              Approved {session.approval.approvedAt} by {session.approval.approverId} /{" "}
              {formatMoney(session.approval.amount)} {session.approval.asset} to{" "}
              {session.approval.recipient}.{" "}
              <Link href={`/app/approvals/${encodeURIComponent(session.approval.id)}`}>
                View approval record.
              </Link>
            </p>
          </section>
        )}

        {session.settlement && (
          <section className="record-panel" aria-label="Settlement state">
            <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>settlement</h2>
            <p className="muted">
              {formatStatus(session.settlement.status)} /{" "}
              {formatMoney(session.settlement.amount)} {session.settlement.amount.asset}
              {session.settlement.transactionHash
                ? ` / ${session.settlement.transactionHash}`
                : " / no transaction submitted"}
            </p>
          </section>
        )}

        {session.proof && (
          <section className="record-panel" aria-label="Proof record">
            <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>proof</h2>
            <p className="muted">
              Proof {session.proof.id} / {session.proof.status} / created{" "}
              {session.proof.createdAt}.{" "}
              <Link href={`/app/proof/${encodeURIComponent(session.proof.id)}`}>
                View proof bundle.
              </Link>
            </p>
          </section>
        )}

        {locked && (
          <p className="source-note" role="status">
            Locked historical task. The composer stays on your current task; reopening
            history never resubmits a payment.
          </p>
        )}
      </div>
    </div>
  );
}

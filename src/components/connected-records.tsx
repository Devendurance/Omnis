"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  Activity,
  FileCheck2,
  MessagesSquare,
  Search,
  ShieldCheck,
} from "lucide-react";
import { formatMoney } from "@/lib/domain";
import { useAuth } from "@/lib/auth";
import { pageContent } from "@/lib/ui-model";
import { serviceRegistry } from "@/lib/services/registry";
import { loadDraftSession } from "@/lib/tasks/persistence";
import {
  activityMatchesQuery,
  deriveActivityEvents,
  filterActivityEvents,
  filterTaskHistory,
  historyRowId,
  listTaskHistory,
  loadTaskArchive,
  summarizeTaskSession,
  taskDisplayStatus,
  taskMatchesQuery,
  taskModeLabel,
  type ActivityEvent,
} from "@/lib/tasks/archive";
import type { TaskSession } from "@/lib/tasks/session";
import { ActionLink } from "./ui";

export type RecordKind = "tasks" | "activity" | "policies" | "approvals";

const icons = {
  tasks: MessagesSquare,
  activity: Activity,
  policies: ShieldCheck,
  approvals: FileCheck2,
};
function useTaskHistory() {
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
  return useMemo(() => {
    // Server and first client render share the loading shell; owner history
    // loads only after mount so hydration never diverges.
    void tick;
    if (!mounted) {
      return {
        ready: false,
        authenticated: false as const,
        active: null as TaskSession | null,
        archived: [] as readonly TaskSession[],
        history: [] as readonly TaskSession[],
      };
    }
    void tick;
    if (!auth.ready || !auth.authenticated || !ownerSubject) {
      return {
        ready: auth.ready,
        authenticated: false as const,
        active: null as TaskSession | null,
        archived: [] as readonly TaskSession[],
        history: [] as readonly TaskSession[],
      };
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
      archived = loadTaskArchive(
        window.localStorage,
        ownerSubject,
        serviceRegistry,
      );
    } catch {
      archived = [];
    }
    return {
      ready: true,
      authenticated: true as const,
      active,
      archived,
      history: listTaskHistory(active, archived),
    };
  }, [auth.ready, auth.authenticated, ownerSubject, tick, mounted]);
}

function formatStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function formatTimestamp(at: string): string {
  if (!at) return "unknown";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString();
}

function RecordShell({
  kind,
  filter,
  setFilter,
  query,
  setQuery,
  children,
  recordCount,
}: {
  kind: RecordKind;
  filter: string;
  setFilter: (value: string) => void;
  query: string;
  setQuery: (value: string) => void;
  children: React.ReactNode;
  recordCount: number;
}) {
  const content = pageContent[kind];
  const Icon = icons[kind];
  return (
    <div className="collection-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{content.eyebrow}</p>
          <h1>{content.title}</h1>
          <p className="page-description">{content.description}</p>
        </div>
        <span className="page-symbol" aria-hidden="true">
          <Icon size={29} strokeWidth={1.2} />
        </span>
      </div>
      <div className="collection-toolbar">
        <div className="filters" aria-label={`${content.title} filters`}>
          {content.filters.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
              className={filter === item ? "filter is-selected" : "filter"}
            >
              {item}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Search {kind}</span>
          <input
            type="search"
            placeholder={`search ${kind}...`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <section className="record-panel" aria-label={`${content.title} records`}>
        <div className="record-head" aria-hidden="true">
          {content.columns.map((column) => (
            <span key={column}>{column}</span>
          ))}
        </div>
        {children}
      </section>
      <section className="collection-guide">
        <div className="guide-heading">
          <span className="eyebrow">inside omnis</span>
          <h2>{content.detailTitle}</h2>
        </div>
        <div className="guide-items">
          {content.details.map((detail) => (
            <div key={detail.label}>
              <h3>{detail.label}</h3>
              <p>{detail.text}</p>
            </div>
          ))}
        </div>
      </section>
      <p className="source-note" role="status">
        {recordCount === 0
          ? "History is stored locally in this browser under your account."
          : `${recordCount} record${recordCount === 1 ? "" : "s"} from your local task history.`}
      </p>
    </div>
  );
}

function EmptyRecords({ kind }: { kind: RecordKind }) {
  const content = pageContent[kind];
  const Icon = icons[kind];
  return (
    <div className="empty-state">
      <span className="empty-orbit" aria-hidden="true">
        <Icon size={30} strokeWidth={1.1} />
      </span>
      <h2>{content.empty}</h2>
      <p>{content.help}</p>
      <ActionLink href="/app">start a task</ActionLink>
    </div>
  );
}

function TasksRecords() {
  const { ready, authenticated, active, archived, history } = useTaskHistory();
  const content = pageContent.tasks;
  const [filter, setFilter] = useState<string>(content.filters[0]);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const ordered = listTaskHistory(active, archived);
    return filterTaskHistory(ordered, filter)
      .filter((session) => taskMatchesQuery(session, query))
      .map((session) => ({
        id: historyRowId(session, archived),
        summary: summarizeTaskSession(session),
        mode: taskModeLabel(session.task?.type ?? "pay"),
        status: taskDisplayStatus(session),
        updatedAt: session.task?.updatedAt ?? "",
        isActive: session === active,
        hasRecord: session.task?.id !== undefined,
      }));
  }, [active, archived, filter, query]);
  if (!ready) {
    return (
      <RecordShell
        kind="tasks"
        filter={filter}
        setFilter={setFilter}
        query={query}
        setQuery={setQuery}
        recordCount={0}
      >
        <div className="empty-state">
          <p>Loading records...</p>
        </div>
      </RecordShell>
    );
  }
  if (!authenticated) {
    return (
      <RecordShell
        kind="tasks"
        filter={filter}
        setFilter={setFilter}
        query={query}
        setQuery={setQuery}
        recordCount={0}
      >
        <EmptyRecords kind="tasks" />
      </RecordShell>
    );
  }
  return (
    <RecordShell
      kind="tasks"
      filter={filter}
      setFilter={setFilter}
      query={query}
      setQuery={setQuery}
      recordCount={history.length}
    >
      {history.length === 0 ? (
        <EmptyRecords kind="tasks" />
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <h2>No matching tasks.</h2>
          <p>Try another mode or search term.</p>
        </div>
      ) : (
        <div className="record-list">
          {rows.map((row) => (
            <article className="record-row" key={row.id}>
              <div className="record-service">
                <strong>
                  {row.hasRecord ? (
                    <Link href={`/app/tasks/${encodeURIComponent(row.id)}`}>
                      {row.summary}
                    </Link>
                  ) : (
                    row.summary
                  )}
                </strong>
                <span>
                  {row.id}
                  {row.isActive ? " / current task" : ""}
                </span>
              </div>
              <span>{row.mode}</span>
              <span>{formatStatus(row.status)}</span>
              <span>
                {row.updatedAt ? (
                  <time dateTime={row.updatedAt}>
                    {formatTimestamp(row.updatedAt)}
                  </time>
                ) : (
                  "unknown"
                )}
              </span>
            </article>
          ))}
        </div>
      )}
    </RecordShell>
  );
}

function ActivityRecords() {
  const { ready, authenticated, active, archived, history } = useTaskHistory();
  const content = pageContent.activity;
  const [filter, setFilter] = useState<string>(content.filters[0]);
  const [query, setQuery] = useState("");
  const events: readonly ActivityEvent[] = useMemo(
    () =>
      filterActivityEvents(deriveActivityEvents(history), filter).filter(
        (event) => activityMatchesQuery(event, query),
      ),
    [history, filter, query],
  );
  const total = useMemo(() => deriveActivityEvents(history).length, [history]);
  void active;
  void archived;
  if (!ready) {
    return (
      <RecordShell
        kind="activity"
        filter={filter}
        setFilter={setFilter}
        query={query}
        setQuery={setQuery}
        recordCount={0}
      >
        <div className="empty-state">
          <p>Loading records...</p>
        </div>
      </RecordShell>
    );
  }
  if (!authenticated) {
    return (
      <RecordShell
        kind="activity"
        filter={filter}
        setFilter={setFilter}
        query={query}
        setQuery={setQuery}
        recordCount={0}
      >
        <EmptyRecords kind="activity" />
      </RecordShell>
    );
  }
  return (
    <RecordShell
      kind="activity"
      filter={filter}
      setFilter={setFilter}
      query={query}
      setQuery={setQuery}
      recordCount={total}
    >
      {total === 0 ? (
        <EmptyRecords kind="activity" />
      ) : events.length === 0 ? (
        <div className="empty-state">
          <h2>No matching activity.</h2>
          <p>Try another filter or search term.</p>
        </div>
      ) : (
        <div className="record-list">
          {events.map((event) => (
            <article className="record-row" key={event.id}>
              <div className="record-service">
                <strong>{event.label}</strong>
                <span>
                  <time dateTime={event.at}>{formatTimestamp(event.at)}</time>
                </span>
              </div>
              <span>
                <Link href={`/app/tasks/${encodeURIComponent(event.taskId)}`}>
                  {event.taskSummary}
                </Link>
              </span>
              <span className="money">{event.amount ?? "no amount"}</span>
              <span>{formatStatus(event.status)}</span>
            </article>
          ))}
        </div>
      )}
    </RecordShell>
  );
}

type PolicyRow = Readonly<{
  taskId: string;
  taskSummary: string;
  serviceBudget: string;
  approvalRule: string;
  categories: string;
  networks: string;
  maxSpend: string;
  maxPerService: string;
}>;

function PoliciesRecords() {
  const { ready, authenticated, history } = useTaskHistory();
  const content = pageContent.policies;
  const [filter, setFilter] = useState<string>(content.filters[0]);
  const [query, setQuery] = useState("");
  void filter;
  const rows: readonly PolicyRow[] = useMemo(
    () =>
      history
        .filter((session) => session.policy)
        .filter((session) => taskMatchesQuery(session, query))
        .map((session) => {
          const policy = session.policy;
          return {
            taskId: session.task?.id ?? "conversation",
            taskSummary: summarizeTaskSession(session),
            serviceBudget: policy?.maxServiceSpend
              ? `$${formatMoney(policy.maxServiceSpend)}`
              : "not configured",
            approvalRule: policy?.finalPaymentApprovalRequired
              ? "Final payment requires approval"
              : "No final payment in this task",
            categories: policy?.allowedServiceCategories.join(", ") || "none",
            networks:
              policy?.allowedServiceNetworks?.join(", ") ||
              policy?.allowedNetworks.join(", ") ||
              "none",
            maxSpend: policy?.maxServiceSpend
              ? `$${formatMoney(policy.maxServiceSpend)}`
              : "not configured",
            maxPerService: policy?.maxPerService
              ? `$${formatMoney(policy.maxPerService)}`
              : "not configured",
          };
        }),
    [history, query],
  );
  const total = useMemo(
    () => history.filter((session) => session.policy).length,
    [history],
  );
  return (
    <RecordShell
      kind="policies"
      filter={content.filters[0]}
      setFilter={setFilter}
      query={query}
      setQuery={setQuery}
      recordCount={total}
    >
      {!ready ? (
        <div className="empty-state">
          <p>Loading records...</p>
        </div>
      ) : !authenticated ? (
        <EmptyRecords kind="policies" />
      ) : total === 0 ? (
        <EmptyRecords kind="policies" />
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <h2>No matching policies.</h2>
          <p>Try another search term.</p>
        </div>
      ) : (
        <div className="record-list">
          {rows.map((row) => (
            <details className="record-row" key={row.taskId}>
              <summary>
                <div className="record-service">
                  <strong>Task policy</strong>
                  <span>{row.taskId}</span>
                </div>
                <span>{row.taskSummary}</span>
                <span className="money">{row.serviceBudget}</span>
                <span>{row.approvalRule}</span>
              </summary>
              <div className="record-detail">
                <span>allowed service categories: {row.categories}</span>
                <span>allowed networks: {row.networks}</span>
                <span>max service spend: {row.maxSpend}</span>
                <span>max per service: {row.maxPerService}</span>
                <span>approval boundary: {row.approvalRule}</span>
              </div>
            </details>
          ))}
        </div>
      )}
    </RecordShell>
  );
}

type ApprovalRow = Readonly<{
  id: string;
  taskId: string;
  action: string;
  recipient: string;
  amount: string;
  reason: string;
  status: string;
  href: string;
  pending: boolean;
  at: string;
}>;

function ApprovalsRecords() {
  const { ready, authenticated, history } = useTaskHistory();
  const content = pageContent.approvals;
  const [filter, setFilter] = useState<string>(content.filters[0]);
  const [query, setQuery] = useState("");
  void filter;
  const rows: readonly ApprovalRow[] = useMemo(() => {
    const collected: ApprovalRow[] = [];
    for (const session of history) {
      const task = session.task;
      if (!task) continue;
      const summary = summarizeTaskSession(session);
      if (
        task.status === "awaiting_approval" &&
        session.approval === undefined
      ) {
        collected.push({
          id: `${task.id}:pending`,
          taskId: task.id,
          action: "final payment",
          recipient: task.recipient ?? "unknown recipient",
          amount: task.paymentAmount
            ? `${formatMoney(task.paymentAmount)} ${task.paymentAmount.asset}`
            : "amount pending",
          reason: "Final payment requires approval",
          status: "awaiting approval",
          href: `/app/tasks/${encodeURIComponent(task.id)}`,
          pending: true,
          at: task.updatedAt,
        });
      }
      if (session.approval) {
        const approval = session.approval;
        collected.push({
          id: approval.id,
          taskId: task.id,
          action: "final payment",
          recipient: approval.recipient,
          amount: `${formatMoney(approval.amount)} ${approval.asset}`,
          reason: `Approved for ${summary}`,
          status: approval.decision,
          href: `/app/approvals/${encodeURIComponent(approval.id)}`,
          pending: false,
          at: approval.approvedAt,
        });
      }
    }
    collected.sort((left, right) => {
      if (left.pending !== right.pending) return left.pending ? -1 : 1;
      if (right.at !== left.at) return right.at < left.at ? -1 : 1;
      return right.id < left.id ? -1 : 1;
    });
    return collected.filter((row) =>
      [row.action, row.recipient, row.amount, row.reason, row.taskId].some(
        (field) =>
          !query.trim() ||
          field.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    );
  }, [history, query]);
  const total = useMemo(() => {
    let count = 0;
    for (const session of history) {
      if (
        session.task?.status === "awaiting_approval" &&
        session.approval === undefined
      ) {
        count += 1;
      }
      if (session.approval) count += 1;
    }
    return count;
  }, [history]);
  return (
    <RecordShell
      kind="approvals"
      filter={content.filters[0]}
      setFilter={setFilter}
      query={query}
      setQuery={setQuery}
      recordCount={total}
    >
      {!ready ? (
        <div className="empty-state">
          <p>Loading records...</p>
        </div>
      ) : !authenticated ? (
        <EmptyRecords kind="approvals" />
      ) : total === 0 ? (
        <EmptyRecords kind="approvals" />
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <h2>No matching approvals.</h2>
          <p>Try another search term.</p>
        </div>
      ) : (
        <div className="record-list">
          {rows.map((row) => (
            <article className="record-row" key={row.id}>
              <div className="record-service">
                <strong>
                  <Link href={row.href}>{row.action}</Link>
                </strong>
                <span>{row.pending ? "decide in the task" : row.id}</span>
              </div>
              <span>{row.recipient}</span>
              <span className="money">{row.amount}</span>
              <span>
                {row.reason} / {formatStatus(row.status)}
              </span>
            </article>
          ))}
        </div>
      )}
    </RecordShell>
  );
}

export function ConnectedRecords({ kind }: { kind: RecordKind }) {
  if (kind === "activity") return <ActivityRecords />;
  if (kind === "policies") return <PoliciesRecords />;
  if (kind === "approvals") return <ApprovalsRecords />;
  return <TasksRecords />;
}

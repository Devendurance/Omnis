import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  createApprovalRecord,
  createFinancialTask,
  createServicePurchase,
  createTaskPolicy,
  finalizeProof,
  money,
  transitionTask,
  type FinancialTask,
  type ServicePurchase,
  type SettlementExecution,
  type TaskPolicy,
} from "../src/lib/domain";
import {
  createLiveServiceRegistry,
  WALLET_ACTIVITY_SERVICE_ID,
} from "../src/lib/services";
import {
  HEDERA_TESTNET_NETWORK,
  WALLET_ACTIVITY_PRICE,
  WALLET_ACTIVITY_QUOTE,
} from "../src/lib/services/wallet-activity-descriptor";
import {
  beginTaskExecution,
  moveTaskToAwaitingApproval,
} from "../src/lib/tasks/runtime";
import { serializeDraftSession } from "../src/lib/tasks/persistence";
import {
  TASK_SESSION_VERSION,
  type TaskSession,
} from "../src/lib/tasks/session";
import {
  activityMatchesQuery,
  archiveTaskSession,
  clearTaskArchive,
  deriveActivityEvents,
  filterActivityEvents,
  filterTaskHistory,
  findHistorySession,
  getTaskArchiveStorageKey,
  historyRowId,
  listTaskHistory,
  loadTaskArchive,
  summarizeTaskSession,
  taskDisplayStatus,
  taskMatchesQuery,
  taskModeLabel,
} from "../src/lib/tasks/archive";

const NOW = "2026-09-12T12:00:00.000Z";
const LATER = "2026-09-12T13:00:00.000Z";
const OWNER_A = "did:privy:owner-a-p9a7";
const OWNER_B = "did:privy:owner-b-p9a7";
const WALLET_A = "0x1111111111111111111111111111111111111111";
const CONTRACTOR = "0x3333333333333333333333333333333333333333";

function makeStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function makePolicy(taskId: string, spend = "0.05"): TaskPolicy {
  return createTaskPolicy({
    taskId,
    maxServiceSpend: money(spend, "USD"),
    maxPerService: money(spend, "USD"),
    allowedServiceCategories: ["wallet-risk"],
    allowedServiceNetworks: [HEDERA_TESTNET_NETWORK],
    allowedAssets: ["USDC", "USD"],
    allowedNetworks: [],
    finalPaymentApprovalRequired: true,
  });
}

function makeDraftTask(taskId: string, policy: TaskPolicy): FinancialTask {
  return createFinancialTask(
    {
      id: taskId,
      ownerId: OWNER_A,
      ownerSubject: OWNER_A,
      ownerWalletAddress: WALLET_A,
      type: "pay_with_check",
      originalIntent: `Pay contractor ${taskId} 0.10 USDC`,
      recipient: CONTRACTOR,
      paymentAmount: money("0.10", "USDC"),
      purpose: "contractor",
      serviceBudget: policy.maxServiceSpend,
      perServiceCap: policy.maxPerService,
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
}

function makePaidPurchase(taskId: string, policy: TaskPolicy): ServicePurchase {
  return createServicePurchase(
    {
      id: `purchase-${taskId}`,
      taskId,
      serviceId: WALLET_ACTIVITY_SERVICE_ID,
      quotedAmount: WALLET_ACTIVITY_QUOTE,
      paymentAmount: WALLET_ACTIVITY_PRICE,
      paidAmount: WALLET_ACTIVITY_QUOTE,
      policySnapshot: policy,
      status: "paid",
      requestId: `request-${taskId}`,
      paymentIdentifier: "0.0.7162784@1788908433.043020353",
      settlementNetwork: HEDERA_TESTNET_NETWORK,
      serviceResult: {
        observations: { wallet: CONTRACTOR, activityObserved: true },
        heuristicFlags: [],
        disclaimer: "Factual observation result.",
        requestId: `request-${taskId}`,
      },
    },
    NOW,
  );
}

function makeDraftSession(taskId: string): TaskSession {
  const policy = makePolicy(taskId);
  return {
    version: TASK_SESSION_VERSION,
    ownerSubject: OWNER_A,
    ownerWalletAddress: WALLET_A,
    messages: [
      {
        id: `msg-${taskId}`,
        role: "user",
        kind: "message",
        content: `Pay contractor ${taskId} 0.10 USDC`,
        createdAt: NOW,
      },
    ],
    task: makeDraftTask(taskId, policy),
    policy,
  };
}

function makeCompletedSession(taskId: string): TaskSession {
  const policy = makePolicy(taskId);
  const draft = makeDraftTask(taskId, policy);
  const planned = transitionTask(draft, "planned", { now: NOW });
  const running = beginTaskExecution(planned, policy, NOW);
  const purchase = makePaidPurchase(taskId, policy);
  const awaiting = moveTaskToAwaitingApproval(running, policy, [purchase], NOW);
  const settlement: SettlementExecution = {
    id: `settlement-${taskId}`,
    taskId,
    provider: "circle_arc",
    amount: money("0.10", "USDC"),
    recipient: CONTRACTOR,
    network: "Arc Testnet",
    approvalRequired: true,
    policySnapshot: policy,
    status: "confirmed",
    transactionHash: "0xp9a7-transaction",
    confirmationEvidence: {
      source: "reconciliation",
      transactionHash: "0xp9a7-transaction",
      outcome: "confirmed",
      observedAt: LATER,
    },
    createdAt: NOW,
    updatedAt: LATER,
  };
  const approval = createApprovalRecord({
    id: `approval-${taskId}`,
    taskId,
    settlementExecutionId: settlement.id,
    approverId: OWNER_A,
    walletAddress: WALLET_A,
    amount: settlement.amount,
    asset: "USDC",
    recipient: CONTRACTOR,
    network: "Arc Testnet",
    policySnapshot: policy,
    approvedAt: NOW,
  });
  const settling = transitionTask(awaiting, "settling", {
    approval,
    serviceWork: { policy, purchases: [purchase] },
    now: NOW,
  });
  const completed = transitionTask(settling, "completed", {
    approval,
    settlement,
    now: LATER,
  });
  const proof = finalizeProof({
    task: completed,
    policy,
    servicePurchases: [purchase],
    settlement,
    approval,
    intent: { original: `pay contractor ${taskId}` },
    recordedAt: LATER,
  });
  return {
    version: TASK_SESSION_VERSION,
    ownerSubject: OWNER_A,
    ownerWalletAddress: WALLET_A,
    messages: [
      {
        id: `msg-${taskId}`,
        role: "user",
        kind: "message",
        content: `Pay contractor ${taskId} 0.10 USDC`,
        createdAt: NOW,
      },
    ],
    task: completed,
    policy,
    servicePurchases: [purchase],
    approval,
    settlement,
    proof,
  };
}

test.describe("P9A.7 owner-scoped task archive", () => {
  test("previous task survives archiving with full fidelity", () => {
    const storage = makeStorage();
    const registry = createLiveServiceRegistry("available");
    const session = makeCompletedSession("task-a");
    expect(archiveTaskSession(storage, session, OWNER_A, registry)).toBe(true);

    const archived = loadTaskArchive(storage, OWNER_A, registry);
    expect(archived).toHaveLength(1);
    expect(archived[0].task?.id).toBe("task-a");
    expect(archived[0].task?.status).toBe("completed");
    expect(archived[0].policy?.maxServiceSpend).toEqual(money("0.05", "USD"));
    expect(archived[0].servicePurchases).toHaveLength(1);
    expect(archived[0].approval?.decision).toBe("approved");
    expect(archived[0].settlement?.status).toBe("confirmed");
    expect(archived[0].proof?.taskId).toBe("task-a");
    expect(archived[0].messages).toHaveLength(1);
  });

  test("starting a new task keeps the prior record separate", () => {
    const storage = makeStorage();
    const registry = createLiveServiceRegistry("available");
    const taskA = makeDraftSession("task-a");
    expect(archiveTaskSession(storage, taskA, OWNER_A, registry)).toBe(true);

    const taskB = makeDraftSession("task-b");
    const history = listTaskHistory(taskB, loadTaskArchive(storage, OWNER_A, registry));
    expect(history.map((session) => session.task?.id)).toEqual([
      "task-b",
      "task-a",
    ]);
    expect(history[0]).not.toBe(history[1]);
  });

  test("re-archiving the same task id replaces the snapshot instead of duplicating", () => {
    const storage = makeStorage();
    const registry = createLiveServiceRegistry("available");
    archiveTaskSession(storage, makeDraftSession("task-a"), OWNER_A, registry);
    const completed = makeCompletedSession("task-a");
    archiveTaskSession(storage, completed, OWNER_A, registry);

    const archived = loadTaskArchive(storage, OWNER_A, registry);
    expect(archived).toHaveLength(1);
    expect(archived[0].task?.status).toBe("completed");
  });

  test("empty sessions are not archived", () => {
    const storage = makeStorage();
    const empty: TaskSession = { version: TASK_SESSION_VERSION, messages: [] };
    expect(archiveTaskSession(storage, empty, OWNER_A)).toBe(false);
    expect(loadTaskArchive(storage, OWNER_A)).toHaveLength(0);
  });
  test("unreadable archives fail closed without discarding records", () => {
    const registry = createLiveServiceRegistry("available");
    const failing = {
      getItem: (): string | null => {
        throw new Error("storage unavailable");
      },
      setItem: (): void => {
        throw new Error("must not overwrite an unreadable archive");
      },
      removeItem: (): void => {},
    };
    expect(
      archiveTaskSession(failing, makeDraftSession("task-a"), OWNER_A, registry),
    ).toBe(false);
    expect(loadTaskArchive(failing, OWNER_A, registry)).toHaveLength(0);
    const corrupt = makeStorage();
    corrupt.values.set(
      getTaskArchiveStorageKey(OWNER_A) as string,
      "not-json",
    );
    expect(
      archiveTaskSession(corrupt, makeDraftSession("task-a"), OWNER_A, registry),
    ).toBe(false);
    expect(corrupt.values.get(getTaskArchiveStorageKey(OWNER_A) as string)).toBe(
      "not-json",
    );
    const mixed = makeStorage();
    const valid = serializeDraftSession(makeDraftSession("task-a"), registry);
    const mixedRaw = JSON.stringify([valid, 42, ""]);
    mixed.values.set(getTaskArchiveStorageKey(OWNER_A) as string, mixedRaw);
    expect(
      archiveTaskSession(mixed, makeDraftSession("task-b"), OWNER_A, registry),
    ).toBe(false);
    expect(mixed.values.get(getTaskArchiveStorageKey(OWNER_A) as string)).toBe(
      mixedRaw,
    );
    expect(loadTaskArchive(mixed, OWNER_A, registry)).toHaveLength(0);
  });

  test("pristine sessions never render as history", () => {
    const pristine: TaskSession = {
      version: TASK_SESSION_VERSION,
      messages: [],
    };
    expect(listTaskHistory(pristine, [])).toHaveLength(0);
    expect(listTaskHistory(null, [])).toHaveLength(0);
    const storage = makeStorage();
    const registry = createLiveServiceRegistry("available");
    archiveTaskSession(storage, makeDraftSession("task-a"), OWNER_A, registry);
    const archived = loadTaskArchive(storage, OWNER_A, registry);
    const history = listTaskHistory(pristine, archived);
    expect(history).toHaveLength(1);
    expect(history[0].task?.id).toBe("task-a");
  });

  test("archive is owner-scoped and survives a refresh", () => {
    const storage = makeStorage();
    const registry = createLiveServiceRegistry("available");
    archiveTaskSession(storage, makeDraftSession("task-a"), OWNER_A, registry);

    expect(loadTaskArchive(storage, OWNER_B, registry)).toHaveLength(0);
    expect(getTaskArchiveStorageKey(OWNER_A)).not.toBe(
      getTaskArchiveStorageKey(OWNER_B),
    );
    expect(getTaskArchiveStorageKey(undefined)).toBeNull();
    expect(getTaskArchiveStorageKey("  ")).toBeNull();
    expect(archiveTaskSession(storage, makeDraftSession("task-a"), undefined)).toBe(
      false,
    );

    const refresh = makeStorage();
    for (const [key, value] of storage.values) refresh.values.set(key, value);
    const reloaded = loadTaskArchive(refresh, OWNER_A, registry);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].task?.id).toBe("task-a");
  });

  test("archived sessions reject a mismatched owner on hydration", () => {
    const storage = makeStorage();
    const registry = createLiveServiceRegistry("available");
    archiveTaskSession(storage, makeDraftSession("task-a"), OWNER_A, registry);
    const key = getTaskArchiveStorageKey(OWNER_A);
    expect(key).not.toBeNull();
    const raw = storage.values.get(key as string) as string;
    storage.values.set(getTaskArchiveStorageKey(OWNER_B) as string, raw);
    const foreign = loadTaskArchive(storage, OWNER_B, registry);
    expect(foreign).toHaveLength(0);
  });

  test("policies preserve historical snapshots across later tasks", () => {
    const storage = makeStorage();
    const registry = createLiveServiceRegistry("available");
    archiveTaskSession(storage, makeDraftSession("task-a"), OWNER_A, registry);

    const policyB = makePolicy("task-b", "0.09");
    const taskB = createFinancialTask(
      {
        id: "task-b",
        ownerId: OWNER_A,
        ownerSubject: OWNER_A,
        type: "delegate",
        originalIntent: "Research wallets",
        serviceBudget: money("0.09", "USD"),
        perServiceCap: money("0.09", "USD"),
        finalPaymentApprovalRequired: true,
      },
      LATER,
    );
    const sessionB: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: OWNER_A,
      messages: [],
      task: taskB,
      policy: policyB,
    };
    archiveTaskSession(storage, sessionB, OWNER_A, registry);

    const archived = loadTaskArchive(storage, OWNER_A, registry);
    expect(archived).toHaveLength(2);
    expect(archived[0].policy?.maxServiceSpend).toEqual(money("0.05", "USD"));
    expect(archived[1].policy?.maxServiceSpend).toEqual(money("0.09", "USD"));
  });

  test("archive retains previous tasks without eviction", () => {
    const storage = makeStorage();
    const registry = createLiveServiceRegistry("available");
    const total = 55;
    for (let index = 0; index < total; index += 1) {
      archiveTaskSession(
        storage,
        makeDraftSession(`task-${index}`),
        OWNER_A,
        registry,
      );
    }
    const archived = loadTaskArchive(storage, OWNER_A, registry);
    expect(archived).toHaveLength(total);
    expect(archived[0].task?.id).toBe("task-0");
    expect(archived[total - 1].task?.id).toBe(`task-${total - 1}`);
    clearTaskArchive(storage, OWNER_A);
    expect(loadTaskArchive(storage, OWNER_A, registry)).toHaveLength(0);
  });
  test("history resolution performs no financial writes", () => {
    const storage = makeStorage();
    const registry = createLiveServiceRegistry("available");
    archiveTaskSession(storage, makeCompletedSession("task-a"), OWNER_A, registry);
    let writes = 0;
    const spied = {
      getItem: (key: string) => storage.getItem(key),
      setItem: (key: string, value: string) => {
        writes += 1;
        storage.setItem(key, value);
      },
      removeItem: (key: string) => storage.removeItem(key),
    };
    const archived = loadTaskArchive(spied, OWNER_A, registry);
    const resolved = findHistorySession(null, archived, "task-a");
    expect(resolved?.task?.status).toBe("completed");
    expect(deriveActivityEvents(archived)).not.toHaveLength(0);
    expect(writes).toBe(0);
  });
});

test.describe("P9A.7 task summaries, filters, and search", () => {
  test("summaries read like human tasks with modes", () => {
    expect(summarizeTaskSession(makeDraftSession("task-a"))).toBe(
      "Pay contractor 0.1 USDC",
    );
    expect(taskModeLabel("pay")).toBe("pay");
    expect(taskModeLabel("pay_with_check")).toBe("pay + check");
    expect(taskModeLabel("delegate")).toBe("delegate");
  });
  test("display states cover the record lifecycle without proof bias", () => {
    const pristine: TaskSession = {
      version: TASK_SESSION_VERSION,
      messages: [],
    };
    expect(taskDisplayStatus(pristine)).toBe("draft");
    expect(taskDisplayStatus(makeDraftSession("task-a"))).toBe("draft");
    const completed = makeCompletedSession("task-a");
    expect(taskDisplayStatus(completed)).toBe("completed");
    const awaiting: TaskSession = {
      ...completed,
      task: completed.task
        ? { ...completed.task, status: "awaiting_approval" }
        : undefined,
      proof: undefined,
    };
    expect(taskDisplayStatus(awaiting)).toBe("awaiting approval");
    const servicePaid: TaskSession = {
      ...completed,
      task: completed.task ? { ...completed.task, status: "planned" } : undefined,
      approval: undefined,
      settlement: undefined,
      proof: undefined,
    };
    expect(taskDisplayStatus(servicePaid)).toBe("service paid");
    const settling: TaskSession = {
      ...servicePaid,
      task: servicePaid.task ? { ...servicePaid.task, status: "settling" } : undefined,
    };
    expect(taskDisplayStatus(settling)).toBe("settling");
    const failed: TaskSession = {
      ...completed,
      task: completed.task ? { ...completed.task, status: "failed" } : undefined,
    };
    expect(taskDisplayStatus(failed)).toBe("failed");
    const cancelled: TaskSession = {
      ...completed,
      task: completed.task
        ? { ...completed.task, status: "cancelled" }
        : undefined,
    };
    expect(taskDisplayStatus(cancelled)).toBe("cancelled");
    const running: TaskSession = {
      ...servicePaid,
      task: servicePaid.task ? { ...servicePaid.task, status: "running" } : undefined,
      servicePurchases: [],
    };
    expect(taskDisplayStatus(running)).toBe("planned");
  });

  test("mode filters separate pay from delegate", () => {
    const pay = makeDraftSession("task-pay");
    const policy = makePolicy("task-delegate");
    const delegate: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: OWNER_A,
      messages: [],
      task: createFinancialTask(
        {
          id: "task-delegate",
          ownerId: OWNER_A,
          ownerSubject: OWNER_A,
          type: "delegate",
          originalIntent: "Research wallets",
          finalPaymentApprovalRequired: false,
        },
        NOW,
      ),
      policy,
    };
    const sessions = [pay, delegate] as const;
    expect(filterTaskHistory(sessions, "all tasks")).toHaveLength(2);
    expect(
      filterTaskHistory(sessions, "pay").map((s) => s.task?.id),
    ).toEqual(["task-pay"]);
    expect(
      filterTaskHistory(sessions, "delegate").map((s) => s.task?.id),
    ).toEqual(["task-delegate"]);
  });

  test("search matches summary, recipient, and task id", () => {
    const session = makeDraftSession("task-abc");
    expect(taskMatchesQuery(session, "contractor")).toBe(true);
    expect(taskMatchesQuery(session, CONTRACTOR)).toBe(true);
    expect(taskMatchesQuery(session, "task-abc")).toBe(true);
    expect(taskMatchesQuery(session, "unrelated")).toBe(false);
    expect(taskMatchesQuery(session, "  ")).toBe(true);
  });

  test("active session wins over a stale archived snapshot", () => {
    const storage = makeStorage();
    const registry = createLiveServiceRegistry("available");
    archiveTaskSession(storage, makeDraftSession("task-a"), OWNER_A, registry);
    const archived = loadTaskArchive(storage, OWNER_A, registry);
    const active = makeCompletedSession("task-a");
    const history = listTaskHistory(active, archived);
    expect(history).toHaveLength(1);
    expect(history[0].task?.status).toBe("completed");
  });

  test("row ids stay stable for reopening", () => {
    const storage = makeStorage();
    const registry = createLiveServiceRegistry("available");
    archiveTaskSession(storage, makeDraftSession("task-a"), OWNER_A, registry);
    const archived = loadTaskArchive(storage, OWNER_A, registry);
    expect(historyRowId(archived[0], archived)).toBe("task-a");
    expect(findHistorySession(null, archived, "task-a")?.task?.id).toBe(
      "task-a",
    );
    expect(findHistorySession(null, archived, "missing")).toBeNull();
  });
});

test.describe("P9A.7 activity ledger from real events", () => {
  test("completed tasks produce the full real event chain", () => {
    const events = deriveActivityEvents([makeCompletedSession("task-a")]);
    const labels = events.map((event) => event.label);
    expect(labels).toContain("task created");
    expect(labels).toContain("service purchase confirmed");
    expect(labels).toContain("approval granted");
    expect(labels).toContain("settlement submitted");
    expect(labels).toContain("settlement confirmed");
    expect(labels).toContain("task completed");
    expect(labels.indexOf("settlement submitted")).toBeLessThan(
      labels.indexOf("settlement confirmed"),
    );
    const service = events.find(
      (event) => event.label === "service purchase confirmed",
    );
    expect(service?.amount).toContain("0.003");
    const settlement = events.find(
      (event) => event.label === "settlement confirmed",
    );
    expect(settlement?.amount).toBe("0.1 USDC");
  });

  test("draft tasks produce only creation, never synthetic money movement", () => {
    const events = deriveActivityEvents([makeDraftSession("task-a")]);
    expect(events.map((event) => event.label)).toEqual(["task created"]);
    expect(events.every((event) => event.taskId === "task-a")).toBe(true);
  });

  test("taskless conversations contribute no ledger events", () => {
    const session: TaskSession = {
      version: TASK_SESSION_VERSION,
      ownerSubject: OWNER_A,
      messages: [
        {
          id: "m1",
          role: "user",
          kind: "message",
          content: "hello",
          createdAt: NOW,
        },
      ],
    };
    expect(deriveActivityEvents([session])).toHaveLength(0);
    expect(deriveActivityEvents([])).toHaveLength(0);
  });

  test("activity filters separate services, approvals, and settlement", () => {
    const events = deriveActivityEvents([makeCompletedSession("task-a")]);
    expect(
      filterActivityEvents(events, "services").every((e) => e.kind === "service"),
    ).toBe(true);
    expect(
      filterActivityEvents(events, "approvals").map((e) => e.label),
    ).toEqual(["approval granted"]);
    expect(
      filterActivityEvents(events, "settlement").map((e) => e.label),
    ).toEqual(["settlement submitted", "settlement confirmed"]);
    expect(filterActivityEvents(events, "all activity")).toHaveLength(
      events.length,
    );
  });

  test("activity search matches task fields", () => {
    const events = deriveActivityEvents([makeCompletedSession("task-a")]);
    expect(events.filter((e) => activityMatchesQuery(e, "contractor"))).not.toHaveLength(0);
    expect(events.filter((e) => activityMatchesQuery(e, "task-a"))).not.toHaveLength(0);
    expect(events.filter((e) => activityMatchesQuery(e, "0.1"))).not.toHaveLength(0);
    expect(events.filter((e) => activityMatchesQuery(e, "nope"))).toHaveLength(0);
  });
});

test.describe("P9A.7 integrity guards", () => {
  test("archive introduces no financial write surface", () => {
    const source = readFileSync("src/lib/tasks/archive.ts", "utf8");
    expect(source).not.toMatch(/fetch\s*\(/);
    expect(source).not.toContain("service-execution");
    expect(source).not.toContain("execution-gate");
    expect(source).not.toContain("orchestrator");
    expect(source).not.toContain("sign");
  });

  test("approvals list keeps one authoritative approval flow", () => {
    const source = readFileSync("src/components/connected-records.tsx", "utf8");
    expect(source).not.toContain("InlineApprovalCard");
    expect(source).not.toContain("onApprove");
    expect(source).toContain("/app/tasks/");
  });

  test("round trip through serialized storage preserves truth", () => {
    const registry = createLiveServiceRegistry("available");
    const session = makeCompletedSession("task-a");
    const raw = serializeDraftSession(session, registry);
    const storage = makeStorage();
    storage.setItem("key", JSON.stringify([raw]));
    const reloaded = JSON.parse(storage.getItem("key") as string) as string[];
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toBe(raw);
  });
});

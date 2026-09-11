"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { EIP1193Provider } from "viem";
import { hydrateMoney, moneyZero } from "@/lib/domain/money";
import {
  ARC_TESTNET_CHAIN_ID,
  executeCircleSettlement,
  ensureArcTestnetChain,
  type SerializedFinalSettlementPreflight,
} from "@/lib/settlement";
import Image from "next/image";
import {
  ArrowUp,
  ArrowUpRight,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import {
  formatMoney,
  type FinancialTask,
  type ServicePurchase,
  type TaskPolicy,
} from "@/lib/domain";
import { parseFinancialIntent, type ConversationContext } from "@/lib/intent";
import {
  hydrateServiceRegistry,
  resolveRequiredCapability,
  selectServiceCandidate,
  serviceRegistry,
  type ServiceRegistry,
} from "@/lib/services";
import { useAuth, type UserAuthIdentity } from "@/lib/auth";
import {
  LOCAL_DRAFT_OWNER_ID,
  getTaskBudgetState,
  hydrateDraftSession,
  loadDraftSession,
  orchestrateFinancialIntent,
  saveDraftSession,
  selectTaskPlanView,
  serializeDraftSession,
  serializeSettlement,
  TASK_SESSION_VERSION,
  type ChatMessage,
  type PersistedSettlement,
  type TaskDiscoveryState,
  type TaskSession,
} from "@/lib/tasks";
import {
  InlineTaskPlanCard,
  InlineTaskBudgetCard,
  InlineServiceDiscoveryCard,
  InlineServiceResultCard,
  InlineApprovalCard,
  InlineSettlementProgressCard,
  InlineDemoVerifiedCard,
  InlinePaymentCompletedCard,
} from "./conversational-cards";
import { ThinkingIndicator } from "./thinking-indicator";

const examples = [
  { mode: "omnis pay", title: "Pay a contractor", prompt: "Pay a contractor." },
  {
    mode: "omnis pay_with_check",
    title: "Check a wallet before paying",
    prompt:
      "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
  },
  {
    mode: "omnis delegate",
    title: "Give an agent a research budget",
    prompt:
      "Research the best Hedera testnet faucet and report the endpoint. Spend no more than $0.02.",
  },
] as const;

function messageId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}`;
}

function contextFromTask(
  task: FinancialTask | undefined,
  pendingIntent: ConversationContext["pendingIntent"],
): ConversationContext {
  if (pendingIntent) return { pendingIntent };
  if (!task) return {};
  return {
    pendingIntent: {
      type: task.type,
      recipient: task.recipient,
      paymentAmount: task.paymentAmount,
      purpose: task.purpose,
      serviceBudget: task.serviceBudget,
      perServiceCap: task.perServiceCap,
      finalPaymentApprovalRequired: task.finalPaymentApprovalRequired,
    },
  };
}

function discoveryStateForTask(
  task: FinancialTask,
  policy: TaskPolicy,
  servicePurchases: readonly ServicePurchase[],
  registry: ServiceRegistry,
  now: string,
): TaskDiscoveryState | undefined {
  const capability = resolveRequiredCapability(task);
  if (!capability) return undefined;
  const candidate = selectServiceCandidate({
    task,
    policy,
    existingPurchases: servicePurchases,
    registry,
    requiredCapability: capability,
  });
  return Object.freeze({
    requiredCapability: capability,
    discoveredAt: now,
    registryVersion: registry.version,
    ...(candidate.selected
      ? { selectedServiceId: candidate.selected.descriptor.id }
      : {}),
  });
}

type HydrationLifecycle =
  "uninitialized" | "waiting_for_auth" | "hydrating" | "hydrated";

function initialSession(): TaskSession {
  return Object.freeze({
    version: TASK_SESSION_VERSION,
    messages: Object.freeze([]),
  });
}

function logHydrationEvent(
  event:
    | "AUTH_NOT_READY"
    | "AUTH_READY"
    | "OWNER_RESOLVED"
    | "HYDRATION_STARTED"
    | "HYDRATION_SUCCEEDED"
    | "HYDRATION_EMPTY"
    | "PERSISTENCE_ENABLED"
    | "SESSION_WRITE",
): void {
  if (process.env.NODE_ENV === "development") {
    console.debug(`[session] ${event}`);
  }
}

function initialOwnerSession(
  ownerSubject: string | undefined,
  ownerWalletAddress: string | undefined,
): TaskSession {
  return Object.freeze({
    ...initialSession(),
    ...(ownerSubject ? { ownerSubject } : {}),
    ...(ownerWalletAddress ? { ownerWalletAddress } : {}),
  });
}

function initialSessionKey(
  ready: boolean,
  authenticated: boolean,
  ownerSubject: string | undefined,
): string {
  if (!ready) return "not-ready";
  if (!authenticated) return "anonymous";
  return `authenticated:${ownerSubject ?? "missing-owner"}`;
}
type SessionContextGuard = (
  hydrationInput: string,
  ownerSubject: string | undefined,
  taskId: string | undefined,
  runToken: number,
) => boolean;
type SessionContextTokenGetter = () => number;

function finalPaymentLabel(task: FinancialTask): string {
  if (!task.paymentAmount) return "payment amount unavailable";
  return `${formatMoney(task.paymentAmount)} ${task.paymentAmount.asset}`;
}

function FinalPaymentGate({
  task,
  policy,
  servicePurchases,
  session,
  setSession,
  registry,
  auth,
  hydrationInput,
  isSessionContextCurrent,
  getSessionContextRunToken,
}: {
  task: FinancialTask;
  policy: TaskPolicy;
  servicePurchases: readonly ServicePurchase[];
  session: TaskSession;
  setSession: React.Dispatch<React.SetStateAction<TaskSession>>;
  registry: ServiceRegistry;
  auth: UserAuthIdentity;
  hydrationInput: string;
  isSessionContextCurrent: SessionContextGuard;
  getSessionContextRunToken: SessionContextTokenGetter;
}) {
  const activeWallet =
    auth.primaryExecutionWallet?.address ?? task.ownerWalletAddress;
  const operationOwner = auth.ownerSubject;
  const operationTaskId = task.id;
  const isCurrentSessionOperation = (runToken: number) =>
    isSessionContextCurrent(
      hydrationInput,
      operationOwner,
      operationTaskId,
      runToken,
    );
  const commitSession = (next: TaskSession, runToken: number): boolean => {
    if (!isCurrentSessionOperation(runToken)) return false;
    setSession((current) => {
      if (
        !isCurrentSessionOperation(runToken) ||
        current.ownerSubject !== operationOwner ||
        current.task?.id !== operationTaskId
      ) {
        return current;
      }
      return next;
    });
    return true;
  };
  const [testMode, setTestMode] = useState(
    typeof window !== "undefined" &&
      (new URLSearchParams(window.location.search).get("testMode") === "true" ||
        process.env.NEXT_PUBLIC_ENABLE_P6B_TEST_MODE === "true"),
  );
  const [preflight, setPreflight] =
    useState<SerializedFinalSettlementPreflight | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [settlement, setSettlement] = useState<PersistedSettlement | null>(
    () => (session.settlement ? serializeSettlement(session.settlement) : null),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReconciling, setIsReconciling] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [manualRecoveryHash, setManualRecoveryHash] = useState("");
  const [submitStep, setSubmitStep] = useState<string | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(
    () => session.settlement?.transactionHash ?? null,
  );
  useEffect(() => {
    let active = true;
    const operationRunToken = getSessionContextRunToken();
    const isCurrentOperation = () =>
      isSessionContextCurrent(
        hydrationInput,
        operationOwner,
        operationTaskId,
        operationRunToken,
      );
    if (
      task.status !== "awaiting_approval" ||
      !auth.authenticated ||
      !isCurrentOperation()
    ) {
      return;
    }
    (async () => {
      setPreflightLoading(true);
      setPreflightError(null);
      try {
        const token = await auth.getAccessToken();
        if (!token)
          throw new Error("Authentication token required for preflight");

        if (!active || !isCurrentOperation()) return;
        const res = await fetch("/api/tasks/final-settlement", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            action: "prepare",
            session: JSON.parse(serializeDraftSession(session, registry)),
            executionWalletAddress: activeWallet,
            testMode,
          }),
        });

        if (!active || !isCurrentOperation()) return;
        const data = await res.json();
        if (!active || !isCurrentOperation()) return;
        if (!res.ok) {
          throw new Error(data.error ?? "Failed to prepare final settlement");
        }
        setPreflight(data.preflight);
        setSettlement(data.settlement);
      } catch (err) {
        if (!active || !isCurrentOperation()) return;
        setPreflightError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active && isCurrentOperation()) setPreflightLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [
    task.status,
    auth,
    session,
    registry,
    activeWallet,
    testMode,
    hydrationInput,
    operationOwner,
    operationTaskId,
    isSessionContextCurrent,
    getSessionContextRunToken,
  ]);

  if (task.type !== "pay_with_check") {
    return null;
  }

  const isConfirmed = session.settlement?.status === "confirmed";
  const isTestModeActive = Boolean(
    testMode || session.settlement?.testMode || session.approval?.testMode,
  );
  const isTestSettlementConfirmed = isConfirmed && isTestModeActive;
  const displayHash = txHash ?? session.settlement?.transactionHash;

  const handleRecoverLegacySettlement = async (txHashToRecover: string) => {
    const operationRunToken = getSessionContextRunToken();
    const isCurrentOperation = () =>
      isSessionContextCurrent(
        hydrationInput,
        operationOwner,
        operationTaskId,
        operationRunToken,
      );
    if (isRecovering || !isCurrentOperation()) return;
    setIsRecovering(true);
    setExecutionError(null);

    try {
      const token = await auth.getAccessToken();
      if (!isCurrentOperation()) return;
      if (!token)
        throw new Error("Authentication token required for recovery");

      const cleanHash = txHashToRecover.trim();
      const HASH_64_HEX_REGEX = /^0x[0-9a-fA-F]{64}$/;
      if (!HASH_64_HEX_REGEX.test(cleanHash)) {
        throw new Error(
          "Valid 66-character 0x hexadecimal transaction hash is required for recovery",
        );
      }

      const res = await fetch("/api/tasks/final-settlement", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          action: "recover_legacy",
          session: JSON.parse(serializeDraftSession(session, registry)),
          transactionHash: cleanHash,
          executionWalletAddress: activeWallet,
          testMode: true,
        }),
      });

      const data = await res.json();
      if (!isCurrentOperation()) return;
      if (!res.ok) {
        throw new Error(data.error ?? "Legacy recovery request failed");
      }

      const updatedSession: TaskSession =
        hydrateDraftSession(
          JSON.stringify(data.session),
          registry,
          operationOwner ? { expectedOwnerSubject: operationOwner } : {},
        ) ?? session;
      commitSession(updatedSession, operationRunToken);
      setTxHash(cleanHash);
    } catch (err) {
      if (!isCurrentOperation()) return;
      setExecutionError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isCurrentOperation()) {
        setIsRecovering(false);
      }
    }
  };
  const handleReconcileOnchain = async (overrideHash?: string) => {
    const operationRunToken = getSessionContextRunToken();
    const isCurrentOperation = () =>
      isSessionContextCurrent(
        hydrationInput,
        operationOwner,
        operationTaskId,
        operationRunToken,
      );
    if (isReconciling || !isCurrentOperation()) return;
    setIsReconciling(true);
    setExecutionError(null);

    try {
      const token = await auth.getAccessToken();
      if (!isCurrentOperation()) return;
      if (!token)
        throw new Error("Authentication token required for reconciliation");

      const settlementTarget = session.settlement ?? settlement;
      if (!settlementTarget) {
        throw new Error("No settlement execution found to reconcile.");
      }

      const settlementWithHash = overrideHash
        ? { ...settlementTarget, transactionHash: overrideHash }
        : settlementTarget;

      const reconcileRes = await fetch("/api/tasks/final-settlement", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          action: "reconcile",
          session: JSON.parse(serializeDraftSession(session, registry)),
          settlement: settlementWithHash,
          transactionHash: overrideHash ?? settlementWithHash.transactionHash,
          testMode: isTestModeActive,
        }),
      });

      const recData = await reconcileRes.json();
      if (!isCurrentOperation()) return;
      if (!reconcileRes.ok) {
        throw new Error(recData.error ?? "Reconciliation request failed");
      }

      const updatedSession: TaskSession =
        hydrateDraftSession(
          JSON.stringify(recData.session),
          registry,
          operationOwner ? { expectedOwnerSubject: operationOwner } : {},
        ) ?? session;
      commitSession(updatedSession, operationRunToken);

      if (recData.status === "confirmed") {
        setExecutionError(null);
      } else if (recData.status === "reverted") {
        setExecutionError("Transaction execution reverted on Arc Testnet.");
      } else if (
        recData.reconciliationState === "HASH_RECORDED_CHAIN_UNOBSERVED"
      ) {
        setExecutionError(
          "Transaction identifier recorded, but Arc Testnet has not observed the transaction yet.",
        );
      }
    } catch (err) {
      if (!isCurrentOperation()) return;
      setExecutionError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isCurrentOperation()) {
        setIsReconciling(false);
      }
    }
  };

  const handleApproveAndPay = async () => {
    const operationRunToken = getSessionContextRunToken();
    const isCurrentOperation = () =>
      isSessionContextCurrent(
        hydrationInput,
        operationOwner,
        operationTaskId,
        operationRunToken,
      );
    if (isSubmitting || !settlement || !isCurrentOperation()) return;
    setIsSubmitting(true);
    setExecutionError(null);

    try {
      setSubmitStep("approving");
      const token = await auth.getAccessToken();
      if (!isCurrentOperation()) return;
      if (!token) throw new Error("Authentication token required for approval");

      const approveRes = await fetch("/api/tasks/final-settlement", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          action: "approve",
          session: JSON.parse(serializeDraftSession(session, registry)),
          settlement,
          executionWalletAddress: activeWallet,
          testMode,
        }),
      });

      const approveData = await approveRes.json();
      if (!isCurrentOperation()) return;
      if (!approveRes.ok) {
        throw new Error(
          approveData.error ?? "Failed to approve final settlement",
        );
      }

      const authorized = approveData.authorizedExecution;
      const approvedSettlement: PersistedSettlement = approveData.settlement;
      const updatedSession: TaskSession =
        hydrateDraftSession(
          JSON.stringify(approveData.session),
          registry,
          operationOwner ? { expectedOwnerSubject: operationOwner } : {},
        ) ?? session;
      if (!commitSession(updatedSession, operationRunToken)) return;

      setSubmitStep("switching_chain");
      let provider: EIP1193Provider | null = null;
      if (auth.switchExecutionWalletChain) {
        provider = await auth.switchExecutionWalletChain(ARC_TESTNET_CHAIN_ID);
      } else if (auth.getEthereumProvider) {
        provider = await auth.getEthereumProvider();
      }
      if (!isCurrentOperation()) return;

      if (!provider) {
        throw new Error(
          "EIP-1193 provider not available for primary execution wallet.",
        );
      }

      await ensureArcTestnetChain(provider);
      if (!isCurrentOperation()) return;

      setSubmitStep("signing");
      let submitSession: TaskSession = updatedSession;
      let earlySubmittedHash: string | null = null;
      const evidence = await executeCircleSettlement({
        params: {
          sourceWallet: authorized.sourceWallet,
          recipient: authorized.recipient,
          amount: hydrateMoney(authorized.amount),
          sourceChain: "Arc Testnet",
          destinationChain: "Arc Testnet",
          operationType: "erc20_transfer",
          maxFee: moneyZero("USDC", 6),
        },
        provider,
        onTxHashObserved: async (hash) => {
          if (!isCurrentOperation()) return;
          setTxHash(hash);
          if (earlySubmittedHash === hash) return;
          earlySubmittedHash = hash;
          try {
            const earlyRes = await fetch("/api/tasks/final-settlement", {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({
                action: "submit",
                session: JSON.parse(
                  serializeDraftSession(updatedSession, registry),
                ),
                settlement: approvedSettlement,
                transactionHash: hash,
                testMode: isTestModeActive,
              }),
            });
            const earlyData = await earlyRes.json();
            if (!isCurrentOperation()) return;
            if (earlyRes.ok && earlyData.session) {
              submitSession =
                hydrateDraftSession(
                  JSON.stringify(earlyData.session),
                  registry,
                  operationOwner
                    ? { expectedOwnerSubject: operationOwner }
                    : {},
                ) ?? updatedSession;
              commitSession(submitSession, operationRunToken);
            }
          } catch {
            // hash stays in state; the post-evidence submit retries
          }
        },
      });
      if (!isCurrentOperation()) return;

      const observedTxHash = evidence.transactionHash;
      setTxHash(observedTxHash);

      setSubmitStep("submitting");
      const submitRes = await fetch("/api/tasks/final-settlement", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          action: "submit",
          session: JSON.parse(serializeDraftSession(submitSession, registry)),
          settlement: approvedSettlement,
          transactionHash: observedTxHash,
          testMode: isTestModeActive,
        }),
      });

      const submitData = await submitRes.json();
      if (!isCurrentOperation()) return;
      if (!submitRes.ok) {
        throw new Error(
          submitData.error ?? "Failed to record settlement submission",
        );
      }

      let currentSession: TaskSession =
        hydrateDraftSession(
          JSON.stringify(submitData.session),
          registry,
          operationOwner ? { expectedOwnerSubject: operationOwner } : {},
        ) ?? updatedSession;
      if (!commitSession(currentSession, operationRunToken)) return;

      setSubmitStep("confirming");
      let reconciled = false;
      let reconcileAttempts = 0;

      while (!reconciled && reconcileAttempts < 10) {
        if (!isCurrentOperation()) return;
        reconcileAttempts++;
        const reconcileRes = await fetch("/api/tasks/final-settlement", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            action: "reconcile",
            session: JSON.parse(
              serializeDraftSession(currentSession, registry),
            ),
            settlement: submitData.settlement,
            testMode: isTestModeActive,
          }),
        });

        const recData = await reconcileRes.json();
        if (!isCurrentOperation()) return;
        if (recData.status === "confirmed") {
          reconciled = true;
          currentSession =
            hydrateDraftSession(
              JSON.stringify(recData.session),
              registry,
              operationOwner ? { expectedOwnerSubject: operationOwner } : {},
            ) ?? currentSession;
          if (!commitSession(currentSession, operationRunToken)) return;
        } else if (recData.status === "reverted") {
          throw new Error("Transaction execution reverted on Arc Testnet.");
        } else {
          if (recData.session) {
            currentSession =
              hydrateDraftSession(
                JSON.stringify(recData.session),
                registry,
                operationOwner ? { expectedOwnerSubject: operationOwner } : {},
              ) ?? currentSession;
            commitSession(currentSession, operationRunToken);
          }
          if (
            reconcileAttempts >= 3 &&
            recData.reconciliationState === "HASH_RECORDED_CHAIN_UNOBSERVED"
          ) {
            break;
          }
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 2000);
          await promise;
        }
      }
    } catch (err) {
      if (!isCurrentOperation()) return;
      const msg = err instanceof Error ? err.message : String(err);
      setExecutionError(msg);
    } finally {
      if (isCurrentOperation()) {
        setIsSubmitting(false);
        setSubmitStep(null);
      }
    }
  };

  const handleCancel = () => {
    setExecutionError("Settlement approval cancelled by user.");
  };

  if (task.status === "completed" || isTestSettlementConfirmed) {
    const finalHash = session.settlement?.transactionHash ?? txHash;
    if (isTestModeActive) {
      return (
        <InlineDemoVerifiedCard task={task} txHash={finalHash} />
      );
    }

    return (
      <InlinePaymentCompletedCard task={task} txHash={finalHash} />
    );
  }

  if (displayHash && !isConfirmed) {
    return (
      <InlineSettlementProgressCard
        task={task}
        submitStep={submitStep}
        isSubmitting={isSubmitting}
        isReconciling={isReconciling}
        txHash={displayHash ?? null}
        onReconcile={() => handleReconcileOnchain()}
        executionError={executionError}
      />
    );
  }

  if (task.status === "settling" || isSubmitting) {
    return (
      <InlineSettlementProgressCard
        task={task}
        submitStep={submitStep}
        isSubmitting={isSubmitting}
        isReconciling={isReconciling}
        txHash={displayHash ?? null}
        onReconcile={() => handleReconcileOnchain()}
        executionError={executionError}
      />
    );
  }

  if (task.status !== "awaiting_approval") {
    return null;
  }

  return (
    <InlineApprovalCard
      task={task}
      policy={policy}
      servicePurchases={servicePurchases}
      activeWallet={activeWallet}
      preflight={preflight}
      preflightLoading={preflightLoading}
      preflightError={preflightError}
      executionError={executionError}
      testMode={testMode}
      setTestMode={setTestMode}
      onApprove={handleApproveAndPay}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
      submitStep={submitStep}
      manualRecoveryHash={manualRecoveryHash}
      setManualRecoveryHash={setManualRecoveryHash}
      onRecoverLegacy={handleRecoverLegacySettlement}
      isRecovering={isRecovering}
    />
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function Composer() {
  const auth = useAuth();
  const currentOwnerSubject = auth.authenticated
    ? auth.ownerSubject
    : undefined;
  const [value, setValue] = useState("");
  const [session, setSession] = useState<TaskSession>(initialSession);
  const [registry, setRegistry] = useState<ServiceRegistry>(serviceRegistry);
  const [executionPending, setExecutionPending] = useState(false);
  const [executionError, setExecutionError] = useState<string>();
  const [hydrationState, setHydrationState] =
    useState<HydrationLifecycle>("uninitialized");
  const [hydratedInput, setHydratedInput] = useState<string>();
  const [anonymousPersistenceAllowed, setAnonymousPersistenceAllowed] =
    useState(true);
  const wasAuthenticated = useRef(false);
  const hydrationInput = initialSessionKey(
    auth.ready,
    auth.authenticated,
    currentOwnerSubject,
  );
  const persistenceEnabled =
    auth.ready &&
    hydrationState === "hydrated" &&
    hydratedInput === hydrationInput &&
    (auth.authenticated
      ? Boolean(currentOwnerSubject)
      : anonymousPersistenceAllowed);
  const sessionForRender = persistenceEnabled ? session : initialSession();
  const isCaptureLocked =
    sessionForRender.task !== undefined &&
    sessionForRender.task.status !== "draft";
  const isTaskActive =
    sessionForRender.task !== undefined ||
    (sessionForRender.servicePurchases &&
      sessionForRender.servicePurchases.length > 0) ||
    sessionForRender.messages.length > 0;
  const sessionContextRef = useRef({
    hydrationInput,
    hydrationState,
    ownerSubject: currentOwnerSubject,
    taskId: sessionForRender.task?.id,
    runToken: 0,
  });
  useLayoutEffect(() => {
    const current = sessionContextRef.current;
    const runToken =
      current.hydrationInput === hydrationInput &&
      current.hydrationState === hydrationState &&
      current.ownerSubject === currentOwnerSubject &&
      current.taskId === sessionForRender.task?.id
        ? current.runToken
        : current.runToken + 1;
    sessionContextRef.current = {
      hydrationInput,
      hydrationState,
      ownerSubject: currentOwnerSubject,
      taskId: sessionForRender.task?.id,
      runToken,
    };
  }, [
    hydrationInput,
    hydrationState,
    currentOwnerSubject,
    sessionForRender.task?.id,
  ]);
  const getSessionContextRunToken = useCallback(
    () => sessionContextRef.current.runToken,
    [],
  );
  const isSessionContextCurrent = useCallback<SessionContextGuard>(
    (
      expectedHydrationInput,
      expectedOwnerSubject,
      expectedTaskId,
      expectedRunToken,
    ) => {
      const current = sessionContextRef.current;
      return (
        current.hydrationInput === expectedHydrationInput &&
        current.ownerSubject === expectedOwnerSubject &&
        current.taskId === expectedTaskId &&
        current.runToken === expectedRunToken
      );
    },
    [],
  );
  const field = useRef<HTMLTextAreaElement>(null);

  const startNewTask = () => {
    if (!persistenceEnabled) return;
    setSession(
      initialOwnerSession(
        currentOwnerSubject,
        auth.primaryExecutionWallet?.address,
      ),
    );
    setExecutionError(undefined);
    setValue("");
    window.setTimeout(() => field.current?.focus(), 0);
  };

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      if (!auth.ready) {
        logHydrationEvent("AUTH_NOT_READY");
        setHydrationState("waiting_for_auth");
        return;
      }
      logHydrationEvent("AUTH_READY");
      setExecutionPending(false);
      setExecutionError(undefined);
      const previouslyAuthenticated = wasAuthenticated.current;
      wasAuthenticated.current = auth.authenticated;
      if (!auth.authenticated && previouslyAuthenticated) {
        setAnonymousPersistenceAllowed(false);
        setHydratedInput(undefined);
        setHydrationState("waiting_for_auth");
        return;
      }
      if (!auth.authenticated) {
        setAnonymousPersistenceAllowed(true);
      }
      if (auth.authenticated && !currentOwnerSubject) {
        setHydratedInput(undefined);
        setHydrationState("waiting_for_auth");
        return;
      }

      const ownerSubject = auth.authenticated ? currentOwnerSubject : undefined;
      const sessionOptions = ownerSubject
        ? { expectedOwnerSubject: ownerSubject }
        : {};
      logHydrationEvent("OWNER_RESOLVED");
      setHydratedInput(undefined);
      setHydrationState("hydrating");
      logHydrationEvent("HYDRATION_STARTED");

      let stored = loadDraftSession(
        window.localStorage,
        serviceRegistry,
        sessionOptions,
      );
      let nextRegistry = serviceRegistry;
      try {
        const response = await fetch("/api/services", {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error("service registry request failed");
        nextRegistry = hydrateServiceRegistry(await response.json());
      } catch {
        nextRegistry = serviceRegistry;
      }
      if (disposed) return;
      if (nextRegistry !== serviceRegistry) {
        const refreshed = loadDraftSession(
          window.localStorage,
          nextRegistry,
          sessionOptions,
        );
        if (refreshed) stored = refreshed;
      }
      setRegistry(nextRegistry);
      setSession(
        stored ??
          initialOwnerSession(
            ownerSubject,
            auth.authenticated
              ? auth.primaryExecutionWallet?.address
              : undefined,
          ),
      );
      if (stored) {
        logHydrationEvent("HYDRATION_SUCCEEDED");
      } else {
        logHydrationEvent("HYDRATION_EMPTY");
      }
      setHydratedInput(hydrationInput);
      setHydrationState("hydrated");
      logHydrationEvent("PERSISTENCE_ENABLED");
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [
    auth.ready,
    auth.authenticated,
    auth.primaryExecutionWallet?.address,
    currentOwnerSubject,
    hydrationInput,
  ]);

  useEffect(() => {
    if (!persistenceEnabled) return;
    const saved = saveDraftSession(
      session,
      window.localStorage,
      registry,
      currentOwnerSubject
        ? {
            expectedOwnerSubject: currentOwnerSubject,
            persistenceHydrated: true,
          }
        : { persistenceHydrated: true },
    );
    if (saved) logHydrationEvent("SESSION_WRITE");
  }, [registry, session, persistenceEnabled, currentOwnerSubject]);

  const startWalletCheck = async () => {
    if (!persistenceEnabled) return;
    const current = session;
    const wallet = current.task?.recipient;
    if (
      executionPending ||
      !wallet ||
      !current.task ||
      !current.policy ||
      !current.discovery
    ) {
      return;
    }

    const operationInput = hydrationInput;
    const operationOwner = currentOwnerSubject;
    const operationTaskId = current.task.id;
    const operationRunToken = getSessionContextRunToken();
    const isCurrentOperation = () =>
      isSessionContextCurrent(
        operationInput,
        operationOwner,
        operationTaskId,
        operationRunToken,
      );

    if (!auth.authenticated || !currentOwnerSubject) {
      auth.login();
      setExecutionError(
        "Authentication is required to start the wallet check.",
      );
      return;
    }

    setExecutionPending(true);
    setExecutionError(undefined);
    try {
      const token = await auth.getAccessToken();
      if (!isCurrentOperation()) return;
      if (!token) {
        throw new Error(
          "authentication token is required to start the wallet check",
        );
      }
      const persistedSession = JSON.parse(
        serializeDraftSession(current, registry),
      );
      const response = await fetch("/api/tasks/service-purchase", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "start-wallet-check",
          wallet,
          session: persistedSession,
          ownerSubject: currentOwnerSubject,
        }),
      });
      const payload: unknown = await response.json();
      if (!isCurrentOperation()) return;
      if (!response.ok) {
        const message =
          isRecord(payload) && typeof payload.error === "string"
            ? payload.error
            : "wallet activity purchase failed";
        throw new Error(message);
      }
      if (!isRecord(payload) || !payload.session) {
        throw new Error("wallet activity response did not include a session");
      }
      const next = hydrateDraftSession(
        JSON.stringify(payload.session),
        registry,
        { expectedOwnerSubject: operationOwner },
      );
      if (!next)
        throw new Error("wallet activity session could not be restored");
      const outcome =
        typeof payload.outcome === "string" ? payload.outcome : "unknown";
      const finalPayment = next.task
        ? finalPaymentLabel(next.task)
        : "the final contractor";
      const responseMessage =
        outcome === "paid"
          ? `wallet activity check paid and confirmed. The ${finalPayment} payment still needs your approval.`
          : outcome === "recovery"
            ? "payment confirmation is pending. No retry is available; reconcile the persisted payment identifier before continuing."
            : outcome === "failed"
              ? `wallet activity check failed${typeof (payload as { error?: string }).error === "string" ? `: ${(payload as { error: string }).error}` : typeof (payload as { message?: string }).message === "string" ? `: ${(payload as { message: string }).message}` : ""}. No payment was confirmed. The service budget reservation was released.`
              : "wallet activity check is approved and ready.";
      const now = new Date().toISOString();
      const newOmnisMessages: ChatMessage[] = [];
      if (outcome === "paid") {
        newOmnisMessages.push(
          Object.freeze({
            id: messageId("omnis"),
            role: "omnis",
            kind: "message",
            content: "Wallet check complete.",
            createdAt: now,
          }),
          Object.freeze({
            id: messageId("omnis"),
            role: "omnis",
            kind: "message",
            content:
              "I'm ready to prepare the contractor payment. No contractor funds have moved yet.",
            createdAt: new Date(Date.now() + 10).toISOString(),
          }),
        );
      } else {
        newOmnisMessages.push(
          Object.freeze({
            id: messageId("omnis"),
            role: "omnis",
            kind: "message",
            content: responseMessage,
            createdAt: now,
          }),
        );
      }
      setSession((currentSession) => {
        if (
          !isCurrentOperation() ||
          currentSession.ownerSubject !== operationOwner ||
          currentSession.task?.id !== operationTaskId
        ) {
          return currentSession;
        }
        return {
          ...next,
          messages: [...next.messages, ...newOmnisMessages],
        };
      });
      if (outcome === "failed" && isCurrentOperation()) {
        const errText =
          typeof (payload as { error?: string }).error === "string"
            ? (payload as { error: string }).error
            : typeof (payload as { message?: string }).message === "string"
              ? (payload as { message: string }).message
              : undefined;
        setExecutionError(errText);
      }
    } catch (error) {
      if (!isCurrentOperation()) return;
      setExecutionError(
        error instanceof Error
          ? error.message
          : "wallet activity purchase failed",
      );
    } finally {
      if (isCurrentOperation()) setExecutionPending(false);
    }
  };

  return (
    <div className="composer-area">
      {!auth.authenticated && (
        <div className="auth-required-banner" role="status">
          <div className="auth-required-copy">
            <span className="eyebrow">authentication required</span>
            <p>
              Log in with Privy to establish an authenticated task workspace,
              scope policies, and authorize payments.
            </p>
          </div>
          <button
            className="button button-primary auth-action-btn"
            type="button"
            onClick={() => auth.login()}
          >
            <Wallet size={15} aria-hidden="true" />
            log in with privy
          </button>
        </div>
      )}
      {auth.authenticated && (
        <div
          className="workspace-auth-badge"
          role="status"
          aria-label="Authenticated identity"
        >
          <span className="preview-dot" />
          <span className="auth-badge-subject">{auth.ownerSubject}</span>
          <span className="auth-badge-sep" aria-hidden="true">
            /
          </span>
          <span className="auth-badge-wallet">
            {auth.primaryExecutionWallet?.address
              ? `execution wallet: ${auth.primaryExecutionWallet.address}`
              : "embedded wallet initializing"}
          </span>
        </div>
      )}
      {!isTaskActive ? (
        <div className="conversational-empty-state">
          <p className="eyebrow conversational-eyebrow">
            <span className="preview-dot" /> from mandate to proof
          </p>
          <h1 className="conversational-headline">What needs to get done?</h1>
          <p className="conversational-tagline">
            Give Omnis the task, budget, and rules.
          </p>
        </div>
      ) : (
        <div className="conversational-header">
          <h1 className="conversational-headline sr-only">
            What needs to get done?
          </h1>
          <div className="conversational-mandate-bar">
            <span className="eyebrow">
              <span className="preview-dot" /> from mandate to proof
            </span>
            {sessionForRender.task && (
              <span className="mandate-status-pill">
                {sessionForRender.task.status.replaceAll("_", " ")}
              </span>
            )}
          </div>

          <div
            className="conversational-canvas"
            aria-live="polite"
            aria-label="Task conversation"
          >
            {sessionForRender.messages.map((message) => {
              const isUser = message.role === "user";
              return (
                <div
                  key={message.id}
                  className={`conversational-turn ${isUser ? "user-turn" : "omnis-turn"}`}
                >
                  {!isUser && (
                    <div className="omnis-avatar" aria-hidden="true">
                      <Image
                        src="/brand/useomnis-circular-mark-ink.png"
                        alt=""
                        width={24}
                        height={24}
                      />
                    </div>
                  )}
                  <div className="conversational-turn-content">
                    <div
                      className={`conversational-bubble ${isUser ? "user-bubble" : "omnis-bubble"}`}
                    >
                      <p className="eyebrow">{isUser ? "you" : "omnis"}</p>
                      <p>{message.content}</p>
                    </div>

                    {message.plan && (
                      <InlineTaskPlanCard
                        plan={message.plan}
                        task={sessionForRender.task}
                        policy={sessionForRender.policy}
                      />
                    )}
                  </div>
                </div>
              );
            })}
            {sessionForRender.messages.length === 0 &&
              sessionForRender.task && (
                <div className="conversational-turn omnis-turn">
                  <div className="omnis-avatar" aria-hidden="true">
                    <Image
                      src="/brand/useomnis-circular-mark-ink.png"
                      alt=""
                      width={24}
                      height={24}
                    />
                  </div>
                  <div className="conversational-turn-content">
                    <InlineTaskPlanCard
                      plan={selectTaskPlanView(sessionForRender.task)}
                      task={sessionForRender.task}
                      policy={sessionForRender.policy}
                    />
                  </div>
                </div>
              )}

            {sessionForRender.task && sessionForRender.policy && (
              <div className="conversational-turn omnis-turn">
                <div className="omnis-avatar" aria-hidden="true">
                  <Image
                    src="/brand/useomnis-circular-mark-ink.png"
                    alt=""
                    width={24}
                    height={24}
                  />
                </div>
                <div className="conversational-turn-content">
                  <InlineTaskBudgetCard
                    task={sessionForRender.task}
                    policy={sessionForRender.policy}
                    servicePurchases={sessionForRender.servicePurchases ?? []}
                  />

                  {(!sessionForRender.servicePurchases ||
                    sessionForRender.servicePurchases.length === 0 ||
                    sessionForRender.servicePurchases.every(
                      (p) => p.status === "failed",
                    )) && (
                    <InlineServiceDiscoveryCard
                      task={sessionForRender.task}
                      policy={sessionForRender.policy}
                      servicePurchases={
                        sessionForRender.servicePurchases ?? []
                      }
                      discovery={sessionForRender.discovery}
                      registry={registry}
                      executionPending={executionPending}
                      executionError={executionError}
                      onStartService={startWalletCheck}
                      onReviewService={(serviceId) => {
                        setSession((current) => {
                          if (
                            !current.task ||
                            !current.policy ||
                            !registry.getService(serviceId)
                          ) {
                            return current;
                          }
                          const requiredCapability =
                            resolveRequiredCapability(current.task);
                          if (!requiredCapability) return current;
                          return {
                            ...current,
                            discovery: {
                              ...(current.discovery ?? {
                                requiredCapability,
                                discoveredAt: new Date().toISOString(),
                                registryVersion: registry.version,
                              }),
                              requiredCapability,
                              selectedServiceId: serviceId,
                              registryVersion: registry.version,
                            },
                          };
                        });
                      }}
                    />
                  )}
                </div>
              </div>
            )}

            {sessionForRender.servicePurchases &&
              sessionForRender.servicePurchases.length > 0 &&
              sessionForRender.task &&
              sessionForRender.policy && (
                <div className="conversational-turn omnis-turn">
                  <div className="omnis-avatar" aria-hidden="true">
                    <Image
                      src="/brand/useomnis-circular-mark-ink.png"
                      alt=""
                      width={24}
                      height={24}
                    />
                  </div>
                  <div className="conversational-turn-content">
                    {sessionForRender.servicePurchases.map((purchase) => (
                      <InlineServiceResultCard
                        key={purchase.id}
                        task={sessionForRender.task!}
                        purchase={purchase}
                        budget={getTaskBudgetState(
                          sessionForRender.task!,
                          sessionForRender.policy!,
                          sessionForRender.servicePurchases ?? [],
                        )}
                      />
                    ))}
                  </div>
                </div>
              )}

            {executionPending && (
              <div className="conversational-turn omnis-turn">
                <div className="omnis-turn-content">
                  <ThinkingIndicator phase="wallet_check" />
                </div>
              </div>
            )}

            {sessionForRender.task && sessionForRender.policy && (
              <div className="conversational-turn omnis-turn">
                <div className="omnis-avatar" aria-hidden="true">
                  <Image
                    src="/brand/useomnis-circular-mark-ink.png"
                    alt=""
                    width={24}
                    height={24}
                  />
                </div>
                <div className="conversational-turn-content">
                  <FinalPaymentGate
                    key={`${hydrationInput}:${hydrationState}:${sessionForRender.task.id}`}
                    task={sessionForRender.task}
                    policy={sessionForRender.policy}
                    servicePurchases={sessionForRender.servicePurchases ?? []}
                    session={sessionForRender}
                    setSession={setSession}
                    registry={registry}
                    auth={auth}
                    hydrationInput={hydrationInput}
                    isSessionContextCurrent={isSessionContextCurrent}
                    getSessionContextRunToken={getSessionContextRunToken}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Persistent Sticky Composer */}
      <div className="conversational-sticky-composer">
        <div className="conversational-composer-wrapper">
          {isCaptureLocked && (
            <div className="composer-reset" role="status">
              <p>
                {sessionForRender.task?.status === "planned"
                  ? "plan ready. start the wallet check or start a new task."
                  : "task execution is locked. start a new task to capture another mandate."}
              </p>
              <button
                className="button button-outline new-task-button"
                type="button"
                onClick={startNewTask}
              >
                start a new task
              </button>
            </div>
          )}

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              const text = value.trim();
              if (!persistenceEnabled || !text || isCaptureLocked) return;
              setSession((current) => {
                const parse = parseFinancialIntent(
                  text,
                  contextFromTask(current.task, current.pendingIntent),
                );
                const result = orchestrateFinancialIntent(parse, {
                  ownerId: currentOwnerSubject ?? LOCAL_DRAFT_OWNER_ID,
                  ownerSubject: currentOwnerSubject,
                  ownerWalletAddress: auth.primaryExecutionWallet?.address,
                  existingTask: current.task,
                  existingPolicy: current.policy,
                  now: new Date().toISOString(),
                });
                const now = new Date().toISOString();
                const discovery =
                  result.kind === "planned"
                    ? discoveryStateForTask(
                        result.task,
                        result.policy,
                        current.servicePurchases ?? [],
                        registry,
                        now,
                      )
                    : current.discovery;
                const userMessage: ChatMessage = Object.freeze({
                  id: messageId("user"),
                  role: "user",
                  kind: "message",
                  content: text,
                  createdAt: now,
                });
                const omnisMessage: ChatMessage = Object.freeze({
                  id: messageId("omnis"),
                  role: "omnis",
                  kind: result.kind === "planned" ? "plan" : "clarification",
                  content:
                    result.kind === "planned"
                      ? "I can do that. I'll check the wallet before preparing the payment."
                      : result.clarification,
                  ...(result.plan ? { plan: result.plan } : {}),
                  createdAt: now,
                });
                const nextSession: TaskSession = {
                  version: TASK_SESSION_VERSION,
                  ...(currentOwnerSubject
                    ? { ownerSubject: currentOwnerSubject }
                    : {}),
                  ...(auth.primaryExecutionWallet?.address
                    ? { ownerWalletAddress: auth.primaryExecutionWallet.address }
                    : {}),
                  messages: [...current.messages, userMessage, omnisMessage],
                  ...(result.kind === "planned"
                    ? {}
                    : result.task?.status === "draft"
                      ? { pendingIntent: result.parse.fields }
                      : current.pendingIntent
                        ? { pendingIntent: current.pendingIntent }
                        : {}),
                  ...(result.task
                    ? { task: result.task }
                    : current.task
                      ? { task: current.task }
                      : {}),
                  ...(result.policy
                    ? { policy: result.policy }
                    : current.policy
                      ? { policy: current.policy }
                      : {}),
                  ...(current.servicePurchases
                    ? { servicePurchases: current.servicePurchases }
                    : {}),
                  ...(discovery ? { discovery } : {}),
                };
                return nextSession;
              });
              setValue("");
            }}
          >
            <label htmlFor="task-input" className="sr-only">
              Your financial task
            </label>
            <textarea
              ref={field}
              id="task-input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const form = event.currentTarget.form;
                  if (form) form.requestSubmit();
                }
              }}
              placeholder="Tell Omnis what needs to get done..."
              rows={2}
              maxLength={8000}
              required
              disabled={!persistenceEnabled || isCaptureLocked}
              aria-describedby="composer-help"
            />
            <div className="composer-bottom">
              <span className="composer-mode">
                <span className="preview-dot" /> task · budget · rules
              </span>
              <button
                className="submit-task"
                type="submit"
                aria-label="Submit task"
                disabled={!persistenceEnabled || isCaptureLocked || !value.trim()}
              >
                <ArrowUp size={20} aria-hidden="true" />
              </button>
            </div>
          </form>

          <p id="composer-help" className="composer-help">
            <ShieldCheck size={14} aria-hidden="true" />
            You define the task. You keep control.
            <span>
              Enter to send · Shift+Enter for new line
            </span>
          </p>

          {!isTaskActive && (
            <div className="conversational-prompt-starters">
              <span className="prompt-starters-label">try an example</span>
              <div className="prompt-starters-grid">
                {examples.map((example) => (
                  <button
                    key={example.title}
                    type="button"
                    className="prompt-starter-pill"
                    onClick={() => {
                      setValue(example.prompt);
                      field.current?.focus();
                    }}
                  >
                    <span>{example.title}</span>
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

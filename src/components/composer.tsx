"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { EIP1193Provider } from "viem";
import { hydrateMoney, moneyZero, serializeMoney } from "@/lib/domain/money";
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
  Plus,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import {
  formatMoney,
  type FinancialTask,
  type ServicePurchase,
  type TaskPolicy,
} from "@/lib/domain";
import {
  buildAuthoritativeParseResult,
  parseFinancialIntent,
  pendingFieldForIntent,
  type ConversationContext,
} from "@/lib/intent";
import { readPromotedIntent } from "@/lib/conversation/promoted";
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
  archiveTaskSession,
  getTaskBudgetState,
  isServiceExecutionOffered,
  hydrateDraftSession,
  loadDraftSession,
  orchestrateFinancialIntent,
  saveDraftSession,
  serializeDraftSession,
  selectTaskPlanView,
  retainMessagesForTask,
  canStartNewTask,
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
import { buildInterpretRequestBody } from "@/lib/conversation/request";
import type { StoredServiceRecommendation } from "@/lib/recommendation/verifier";
import {
  buildRecommendationCandidateSet,
  decideRecommendationRefresh,
  isRecommendationStale,
} from "@/lib/recommendation";
import {
  containsAuthorityBypassClaim,
  SECURITY_REFUSAL_MESSAGE,
} from "@/lib/conversation/authority";
import { isSynthesisWriteStale } from "@/lib/conversation/synthesize";
import { isRecordObject } from "@/lib/conversation/guard";
import {
  ConversationalThinkingBubble,
  useConversationalMotion,
} from "./conversational-motion";

const CONVERSATION_ENABLED =
  process.env.NEXT_PUBLIC_OMNIS_CONVERSATION_ENABLED === "true";

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
      ...(task.paymentAmount ? { paymentAsset: task.paymentAmount.asset } : {}),
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
  onBusyChange,
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
  onBusyChange: (busy: boolean) => void;
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
    onBusyChange(isSubmitting || isReconciling || isRecovering);
    return () => onBusyChange(false);
  }, [isRecovering, isReconciling, isSubmitting, onBusyChange]);
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
export function Composer() {
  const auth = useAuth();
  const currentOwnerSubject = auth.authenticated
    ? auth.ownerSubject
    : undefined;
  const [newTaskError, setNewTaskError] = useState<string>();
  const [value, setValue] = useState("");
  const [session, setSession] = useState<TaskSession>(initialSession);
  const [registry, setRegistry] = useState<ServiceRegistry>(serviceRegistry);
  const [executionPending, setExecutionPending] = useState(false);
  const [financialExecutionPending, setFinancialExecutionPending] =
    useState(false);
  const [interpretPending, setInterpretPending] = useState(false);
  const [executionError, setExecutionError] = useState<string>();
  const [taskActionsOpen, setTaskActionsOpen] = useState(false);
  const [recommendationPending, setRecommendationPending] = useState(false);
  const recommendationKeyRef = useRef<string | null>(null);
  const conversationalMotion = useConversationalMotion();
  // Stable aliases: the motion controller identity changes when entries
  // publish, so the recommendation effect depends on these callbacks only.
  const beginRecommendationMotion = conversationalMotion.begin;
  const resolveRecommendationMotion = conversationalMotion.resolve;
  const deferredMotionIdsRef = useRef(new Set<string>());
  const interpretAbortRef = useRef<AbortController | null>(null);
  const operationGenerationRef = useRef(0);
  const taskActionsRef = useRef<HTMLDivElement>(null);
  const taskActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const taskActionsMenuRef = useRef<HTMLDivElement>(null);
  const taskActionsItemRef = useRef<HTMLButtonElement>(null);
  const taskActionsMenuId = useId();
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
  const isTaskCorrectable =
    CONVERSATION_ENABLED &&
    sessionForRender.task !== undefined &&
    (sessionForRender.task.status === "planned" ||
      sessionForRender.task.status === "awaiting_approval") &&
    sessionForRender.approval === undefined &&
    sessionForRender.settlement === undefined &&
    (sessionForRender.servicePurchases ?? []).every(
      (purchase) => purchase.status === "failed",
    );
  const isCaptureLocked =
    sessionForRender.task !== undefined &&
    sessionForRender.task.status !== "draft" &&
    !isTaskCorrectable;
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

  const finishLiveMotion = useCallback(() => {
    for (const id of conversationalMotion.pendingIds) {
      const entry = conversationalMotion.get(id);
      if (entry?.text !== undefined) continue;
      const message = session.messages.find((candidate) => candidate.id === id);
      if (message?.role === "omnis") {
        conversationalMotion.resolve(id, message.content);
      }
    }
    conversationalMotion.finishAll();
    deferredMotionIdsRef.current.clear();
  }, [conversationalMotion, session.messages]);

  useEffect(() => {
    for (const id of conversationalMotion.pendingIds) {
      if (deferredMotionIdsRef.current.has(id)) continue;
      const entry = conversationalMotion.get(id);
      if (entry?.text !== undefined) continue;
      const message = session.messages.find((candidate) => candidate.id === id);
      if (message?.role === "omnis") {
        conversationalMotion.resolve(id, message.content);
      }
    }
  }, [conversationalMotion, session.messages]);

  const closeTaskActions = useCallback((restoreFocus = true) => {
    setTaskActionsOpen(false);
    if (restoreFocus) {
      window.setTimeout(() => taskActionsTriggerRef.current?.focus(), 0);
    }
  }, []);

  useEffect(() => {
    if (!taskActionsOpen) return;
    const frame = window.requestAnimationFrame(() => taskActionsItemRef.current?.focus());
    const handlePointerDown = (event: PointerEvent) => {
      if (!taskActionsRef.current?.contains(event.target as Node)) {
        closeTaskActions(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTaskActions(true);
        return;
      }
      if (
        event.target === taskActionsItemRef.current &&
        ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
      ) {
        event.preventDefault();
        taskActionsItemRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeTaskActions, taskActionsOpen]);
  const startNewTask = useCallback(() => {
    if (!persistenceEnabled) return;
    const eligibility = canStartNewTask(
      sessionForRender,
      executionPending || financialExecutionPending,
    );
    closeTaskActions(false);
    if (!eligibility.allowed) {
      setNewTaskError(eligibility.reason);
      window.setTimeout(() => taskActionsTriggerRef.current?.focus(), 0);
      return;
    }
    operationGenerationRef.current += 1;
    interpretAbortRef.current?.abort();
    interpretAbortRef.current = null;
    finishLiveMotion();
    const fresh = initialOwnerSession(
      currentOwnerSubject,
      auth.primaryExecutionWallet?.address,
    );
    const hadHistory =
      sessionForRender.task !== undefined ||
      sessionForRender.messages.length > 0 ||
      (sessionForRender.servicePurchases ?? []).length > 0 ||
      sessionForRender.approval !== undefined ||
      sessionForRender.settlement !== undefined ||
      sessionForRender.proof !== undefined ||
      sessionForRender.pendingIntent !== undefined;
    let preserved = false;
    try {
      // Archive first and confirm before touching the active key: a failed
      // archive must never be followed by overwriting the outgoing task.
      const archived = currentOwnerSubject
        ? archiveTaskSession(
            window.localStorage,
            sessionForRender,
            currentOwnerSubject,
            registry,
          )
        : true;
      if (!hadHistory || archived) {
        // Persist synchronously so navigation after reset never re-reads the
        // archived task as active. The save effect repeats the same write.
        preserved = saveDraftSession(
          fresh,
          window.localStorage,
          registry,
          currentOwnerSubject
            ? {
                expectedOwnerSubject: currentOwnerSubject,
                persistenceHydrated: true,
              }
            : { persistenceHydrated: true },
        );
      }
    } catch {
      preserved = false;
    }
    if (!preserved) {
      setNewTaskError(
        "The current task could not be preserved. No new task was started.",
      );
      window.setTimeout(() => taskActionsTriggerRef.current?.focus(), 0);
      return;
    }
    setSession(fresh);
    setExecutionError(undefined);
    setNewTaskError(undefined);
    setInterpretPending(false);
    setValue("");
    window.setTimeout(() => field.current?.focus(), 0);
  }, [
    closeTaskActions,
    currentOwnerSubject,
    executionPending,
    financialExecutionPending,
    finishLiveMotion,
    auth.primaryExecutionWallet?.address,
    persistenceEnabled,
    registry,
    sessionForRender,
  ]);

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
  useEffect(() => {
    const task = session.task;
    const policy = session.policy;
    const pendingClarification = session.pendingIntent !== undefined;
    if (
      !persistenceEnabled ||
      !task ||
      !policy ||
      !isServiceExecutionOffered(task, pendingClarification) ||
      !resolveRequiredCapability(task)
    ) {
      // Eligibility lost (or never present): clear a stuck pending flag in a
      // microtask so the render path never shows a phantom comparison.
      if (recommendationKeyRef.current !== null) {
        recommendationKeyRef.current = null;
        queueMicrotask(() => setRecommendationPending(false));
      }
      return;
    }
    const capability = resolveRequiredCapability(task) ?? "";
    // P9B.2 single invalidation identity via the exact predicate tested in
    // P9B.2: same key suppresses, a current stored entry suppresses, anything
    // else fetches exactly once for this context.
    const decision = decideRecommendationRefresh({
      stored: session.recommendation,
      task,
      policy,
      requiredCapability: capability,
      registryVersion: registry.version,
      currentKey: recommendationKeyRef.current,
    });
    if (!decision.fetch) {
      recommendationKeyRef.current = decision.key;
      return;
    }
    const key = decision.key;
    recommendationKeyRef.current = key;
    const motionId = `recommendation-${task.id}-${task.updatedAt}`;
    const controller = new AbortController();
    let cancelled = false;
    let settled = false;
    beginRecommendationMotion(motionId);
    void (async () => {
      setRecommendationPending(true);
      try {
        const response = await fetch("/api/services/recommendation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session: serializeDraftSession(session, registry),
          }),
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!response.ok) {
          settled = true;
          resolveRecommendationMotion(motionId, "");
          return;
        }
        const payload = (await response.json()) as {
          ok?: boolean;
          stored?: StoredServiceRecommendation;
        };
        if (cancelled) return;
        if (payload.ok && payload.stored) {
          const stored = payload.stored;
          settled = true;
          // Only verified model recommendations drive the typed motion and
          // the Recommended by Omnis treatment. Deterministic fallback
          // entries resolve empty motion and render no recommendation label.
          if (stored.verified && !stored.fallback) {
            resolveRecommendationMotion(motionId, stored.rationale);
          } else {
            resolveRecommendationMotion(motionId, "");
          }
          setSession((current) => {
            if (
              current.task?.id !== task.id ||
              current.task.updatedAt !== task.updatedAt
            ) {
              return current;
            }
            return { ...current, recommendation: stored };
          });
        } else {
          settled = true;
          resolveRecommendationMotion(motionId, "");
        }
      } catch {
        // Recommendation is advisory only; the deterministic card stays usable.
        if (!cancelled) {
          settled = true;
          resolveRecommendationMotion(motionId, "");
        }
      } finally {
        if (!cancelled && recommendationKeyRef.current === key) {
          setRecommendationPending(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      // This run owned the key: release it so the next run refetches instead
      // of early-returning on a key whose request was just cancelled (session
      // updates such as appended user messages rerun the effect on the same
      // key, including the correction path).
      if (recommendationKeyRef.current === key) {
        recommendationKeyRef.current = null;
      }
      // Never leave a thinking bubble behind on correction, retry, or
      // unmount: an unresolved motion id blocks the queue behind it.
      if (!settled) {
        settled = true;
        resolveRecommendationMotion(motionId, "");
      }
    };
  }, [session, registry, persistenceEnabled, beginRecommendationMotion, resolveRecommendationMotion]);

  const startWalletCheck = async () => {

    if (!persistenceEnabled) return;
    const current = session;
    const wallet = current.task?.recipient;
    if (
      executionPending ||
      !wallet ||
      !current.task ||
      !current.policy ||
      !current.discovery ||
      !isServiceExecutionOffered(current.task, current.pendingIntent !== undefined)
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
          isRecordObject(payload) && typeof payload.error === "string"
            ? payload.error
            : "wallet activity purchase failed";
        throw new Error(message);
      }
      if (!isRecordObject(payload) || !payload.session) {
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
      for (const message of newOmnisMessages) {
        if (outcome === "paid" && message === newOmnisMessages[1]) {
          deferredMotionIdsRef.current.add(message.id);
        }
        conversationalMotion.begin(message.id);
      }
      if (outcome === "paid") {
        conversationalMotion.resolve(newOmnisMessages[0].id, newOmnisMessages[0].content);
      } else {
        for (const message of newOmnisMessages) {
          conversationalMotion.resolve(message.id, message.content);
        }
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
      if (outcome === "paid" && isCurrentOperation()) {
        const synthesisTargetId = newOmnisMessages[1]?.id;
        const synthesisFallback = newOmnisMessages[1]?.content;
        const resolveSynthesisFallback = () => {
          if (synthesisTargetId && synthesisFallback) {
            deferredMotionIdsRef.current.delete(synthesisTargetId);
            conversationalMotion.resolve(synthesisTargetId, synthesisFallback);
          }
        };
        const paidPurchase = [...(next.servicePurchases ?? [])]
          .reverse()
          .find((entry) => entry.status === "paid");
        if (CONVERSATION_ENABLED && synthesisTargetId && paidPurchase && paidPurchase.paymentAmount && next.task) {
          const synthesisPaidAmount = paidPurchase.paidAmount ?? paidPurchase.paymentAmount;
          const synthesisPaymentAmount = paidPurchase.paymentAmount;
          const synthesisTaskId = next.task.id;
          const synthesisOwner = operationOwner;
          const synthesisApproval = next.approval;
          const synthesisSettlement = next.settlement;
          void (async () => {
            try {
              const synthesisResponse = await fetch("/api/conversation", {
                method: "POST",
                headers: { "content-type": "application/json", accept: "application/json" },
                body: JSON.stringify({
                  action: "synthesize",
                  userText: "summarize the wallet check",
                  purchase: {
                    paidAmount: serializeMoney(synthesisPaidAmount),
                    paymentAmount: serializeMoney(synthesisPaymentAmount),
                    status: paidPurchase.status,
                    serviceResult: paidPurchase.serviceResult ?? null,
                  },
                  serviceBudget: next.task?.serviceBudget
                    ? serializeMoney(next.task.serviceBudget)
                    : null,
                  paymentText: finalPayment + " payment",
                  approvalStillRequired: true,
                }),
              });
               if (!synthesisResponse.ok) {
                 resolveSynthesisFallback();
                 return;
               }
              const synthesisPayload: unknown = await synthesisResponse.json();
              if (
                typeof synthesisPayload !== "object" ||
                synthesisPayload === null ||
                Array.isArray(synthesisPayload)
              ) {
                 resolveSynthesisFallback();
                 return;
              }
              if (!("message" in synthesisPayload) || typeof synthesisPayload.message !== "string") {
                 resolveSynthesisFallback();
                 return;
              }
              if (!("fallback" in synthesisPayload)) {
                 resolveSynthesisFallback();
                 return;
              }
              const narrative = synthesisPayload.message;
              setSession((prev) => {
                if (prev.task?.id !== synthesisTaskId || prev.ownerSubject !== synthesisOwner) {
                  return prev;
                }
                if (
                  isSynthesisWriteStale(
                    { approval: prev.approval, settlement: prev.settlement },
                    { approval: synthesisApproval, settlement: synthesisSettlement },
                  )
                ) {
                  return prev;
                }
                return {
                  ...prev,
                  messages: prev.messages.map((m) =>
                    m.id === synthesisTargetId ? { ...m, content: narrative } : m,
                  ),
                };
              });
              deferredMotionIdsRef.current.delete(synthesisTargetId);
              conversationalMotion.resolve(synthesisTargetId, narrative);
            } catch {
              resolveSynthesisFallback();
            }
          })();
        } else {
          resolveSynthesisFallback();
        }
      }
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
            aria-label="Task conversation"
          >
            {sessionForRender.messages.map((message) => {
              const isUser = message.role === "user";
              const motion = isUser ? undefined : conversationalMotion.get(message.id);
              const isThinking = motion?.phase === "thinking";
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
                    {isThinking ? (
                      <div
                        className="conversational-thinking-bubble"
                        role="status"
                        aria-label="Omnis is thinking"
                        data-testid="omnis-thinking"
                      >
                        <span className="conversational-thinking-dots" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                        </span>
                        <span className="sr-only">Omnis is thinking</span>
                      </div>
                    ) : (
                      <div
                        className={`conversational-bubble ${isUser ? "user-bubble" : "omnis-bubble"}`}
                        data-testid={!isUser && motion?.phase === "typing" ? "omnis-typing" : undefined}
                      >
                        <p className="eyebrow">{isUser ? "you" : "omnis"}</p>
                        <p aria-hidden={!isUser && motion?.phase === "typing" ? true : undefined}>
                          {isUser ? message.content : (motion?.visibleText ?? message.content)}
                        </p>
                      </div>
                    )}
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
            {conversationalMotion.pendingIds
              .filter((id) => !sessionForRender.messages.some((message) => message.id === id))
              .map((id) => <ConversationalThinkingBubble key={id} />)}
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
                      hasPendingClarification={sessionForRender.pendingIntent !== undefined}
                      recommendation={sessionForRender.recommendation ?? null}
                      recommendationHistorical={(() => {
                        // Full staleness against the current candidate set,
                        // not just identity fields: a same-version registry
                        // status, price, or eligibility change must demote a
                        // verified entry to historical metadata.
                        const stored = sessionForRender.recommendation;
                        if (!stored) return false;
                        const capability = resolveRequiredCapability(sessionForRender.task);
                        if (!capability) return true;
                        const pending = sessionForRender.pendingIntent !== undefined;
                        const candidateSet = buildRecommendationCandidateSet({
                          task: sessionForRender.task,
                          policy: sessionForRender.policy,
                          registry,
                          requiredCapability: capability,
                          existingPurchases: sessionForRender.servicePurchases ?? [],
                          hasPendingClarification: pending,
                        });
                        return isRecommendationStale({
                          stored,
                          task: sessionForRender.task,
                          policy: sessionForRender.policy,
                          requiredCapability: capability,
                          registryVersion: registry.version,
                          candidateSet,
                        });
                      })()}
                      recommendationPending={recommendationPending}
                      recommendationMotion={(() => {
                        const motionTask = sessionForRender.task;
                        if (!motionTask) return undefined;
                        return conversationalMotion.get(
                          `recommendation-${motionTask.id}-${motionTask.updatedAt}`,
                        );
                      })()}
                      {...(isServiceExecutionOffered(
                        sessionForRender.task,
                        sessionForRender.pendingIntent !== undefined,
                      )
                        ? { onStartService: startWalletCheck }
                        : {})}
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

            {interpretPending && (
              <div className="conversational-turn omnis-turn">
                <div className="omnis-turn-content">
                  <ThinkingIndicator phase="understanding" />
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
                    onBusyChange={setFinancialExecutionPending}
                  />
                </div>
              </div>
            )}
          </div>
          <div
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={
              [...sessionForRender.messages]
                .reverse()
                .map((message) =>
                  message.role === "omnis" ? conversationalMotion.get(message.id) : undefined,
                )
                .find((motion) => motion?.phase === "complete")?.visibleText ?? ""
            }
          />
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
          {isTaskCorrectable && !isCaptureLocked && (
            <div className="composer-reset" role="status">
              <p>
                plan ready. send a follow-up to correct it, start the wallet check, or start a
                new task.
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
              if (!persistenceEnabled || !text || isCaptureLocked || interpretPending) return;
              const interpretationGeneration = ++operationGenerationRef.current;
              interpretAbortRef.current?.abort();
              const interpretationAbort = new AbortController();
              interpretAbortRef.current = interpretationAbort;
              const userMessageId = messageId("user");
              const submitOmnisMessageId = messageId("omnis");
              const submitSnapshot = session;
              const submitTask = submitSnapshot.task;
              const submitCorrectable =
                submitTask !== undefined &&
                (submitTask.status === "planned" || submitTask.status === "awaiting_approval") &&
                submitSnapshot.approval === undefined &&
                submitSnapshot.settlement === undefined &&
                (submitSnapshot.servicePurchases ?? []).every(
                  (purchase) => purchase.status === "failed",
                );
              const submitPendingIntent =
                submitSnapshot.pendingIntent ??
                (submitCorrectable && submitTask
                  ? {
                      type: submitTask.type,
                      recipient: submitTask.recipient,
                      paymentAmount: submitTask.paymentAmount,
                      paymentAsset: submitTask.paymentAmount?.asset,
                      purpose: submitTask.purpose,
                      serviceBudget: submitTask.serviceBudget,
                      perServiceCap: submitTask.perServiceCap,
                    }
                  : undefined);
              const submitPendingField = pendingFieldForIntent(submitPendingIntent);
              const submitOwnerSubject = currentOwnerSubject;
              const submitWalletAddress = auth.primaryExecutionWallet?.address;
              const userCreatedAt = new Date().toISOString();
               setSession((current) => ({
                ...current,
                messages: [
                  ...current.messages,
                  Object.freeze({
                    id: userMessageId,
                    role: "user",
                    kind: "message",
                    content: text,
                    createdAt: userCreatedAt,
                  }),
                 ],
               }));
               finishLiveMotion();
               conversationalMotion.begin(submitOmnisMessageId);
               setValue("");
              setInterpretPending(true);
              void (async () => {
                let gate: "plan" | "clarify" | "reject_authority_bypass" = "plan";
                let modelCopy: string | undefined;
                let gateMessage: string | undefined;
                let promotedIntentRaw: unknown;
                try {
                  if (!CONVERSATION_ENABLED) {
                    gate = "plan";
                  } else {
                  const response = await fetch("/api/conversation", {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      accept: "application/json",
                    },
                    body: JSON.stringify(
                      buildInterpretRequestBody(text, {
                        messages: submitSnapshot.messages,
                        pendingIntent: submitPendingIntent,
                        pendingField: submitPendingField,
                        task: submitSnapshot.task,
                        policy: submitSnapshot.policy,
                      }),
                    ),
                    signal: AbortSignal.any([
                      interpretationAbort.signal,
                      AbortSignal.timeout(15000),
                    ]),
                  });
                  if (response.ok) {
                    const payload: unknown = await response.json();
                    if (isRecordObject(payload)) {
                      if (
                        payload.gate === "reject_authority_bypass" &&
                        typeof payload.message === "string"
                      ) {
                        gate = "reject_authority_bypass";
                        gateMessage = payload.message;
                      } else if (payload.gate === "clarify" && typeof payload.message === "string") {
                        gate = "clarify";
                        gateMessage = payload.message;
                      } else if (payload.gate === "plan" && typeof payload.message === "string") {
                        gate = "plan";
                        if (payload.fallback === false) modelCopy = payload.message;
                        if (payload.fallback === false) promotedIntentRaw = payload.promotedIntent;
                      }
                    }
                  }
                }
                } catch {
                  if (operationGenerationRef.current !== interpretationGeneration) return;
                  gate = "plan";
                }
                if (operationGenerationRef.current !== interpretationGeneration) return;
                // P9A.4 failsafe: the deterministic guard wins even if the
                // route is unreachable, errors, or returns a stale plan for
                // an authority-bypass turn. This turn must never reach the
                // financial parser or orchestrator below.
                if (gate !== "reject_authority_bypass" && containsAuthorityBypassClaim(text)) {
                  gate = "reject_authority_bypass";
                  if (!gateMessage) gateMessage = SECURITY_REFUSAL_MESSAGE;
                }
                setSession((current) => {
                  if (operationGenerationRef.current !== interpretationGeneration) return current;
                  if (!current.messages.some((m) => m.id === userMessageId)) return current;
                  // P9A.4 security short-circuit: append the refusal and keep
                  // every authoritative financial field byte-for-byte intact.
                  // No parse, no orchestration, no replan, no discovery or
                  // approval mutation from this turn.
                  if (gate === "reject_authority_bypass") {
                    const now = new Date().toISOString();
                    const refusal: ChatMessage = Object.freeze({
                      id: submitOmnisMessageId,
                      role: "omnis",
                      kind: "clarification",
                      content: gateMessage ?? SECURITY_REFUSAL_MESSAGE,
                      createdAt: now,
                    });
                    return { ...current, messages: [...current.messages, refusal] };
                  }
                  const now = new Date().toISOString();
                  const promotedFields =
                    gate === "plan" ? readPromotedIntent(promotedIntentRaw) : undefined;
                  const parse =
                    promotedFields !== undefined
                      ? buildAuthoritativeParseResult(promotedFields, {
                          sourceText: text,
                          hadPending:
                            current.pendingIntent !== undefined || current.task !== undefined,
                        })
                      : parseFinancialIntent(text, {
                          ...contextFromTask(current.task, current.pendingIntent),
                          pendingField: pendingFieldForIntent(current.pendingIntent) ?? undefined,
                        });
                  const isCorrection =
                    current.task !== undefined &&
                    (current.task.status === "planned" ||
                      current.task.status === "awaiting_approval") &&
                    current.approval === undefined &&
                    current.settlement === undefined &&
                    (current.servicePurchases ?? []).every(
                      (purchase) => purchase.status === "failed",
                    );
                  const result = orchestrateFinancialIntent(parse, {
                    ownerId: submitOwnerSubject ?? LOCAL_DRAFT_OWNER_ID,
                    ownerSubject: submitOwnerSubject,
                    ownerWalletAddress: submitWalletAddress,
                    ...(isCorrection
                      ? {}
                      : { existingTask: current.task, existingPolicy: current.policy }),
                    now: new Date().toISOString(),
                  });
                  const taskReplaced =
                    isCorrection &&
                    result.task !== undefined &&
                    result.task.id !== current.task?.id;
                  const discoveryPurchases = taskReplaced ? [] : (current.servicePurchases ?? []);
                  const discovery =
                    result.kind === "planned"
                      ? discoveryStateForTask(
                          result.task,
                          result.policy,
                          discoveryPurchases,
                          registry,
                          now,
                        )
                      : taskReplaced
                        ? undefined
                        : current.discovery;
                  const omnisMessage: ChatMessage = Object.freeze({
                    id: submitOmnisMessageId,
                    role: "omnis",
                    kind: result.kind === "planned" ? "plan" : "clarification",
                    content:
                      gate === "clarify"
                        ? (result.kind === "planned"
                          ? (modelCopy ?? "I can do that. I'll check the wallet before preparing the payment.")
                          : (result.clarification ?? gateMessage ?? "Tell Omnis what needs to be paid or researched."))
                        : result.kind === "planned"
                          ? (modelCopy ??
                            (taskReplaced
                              ? "Got it. I have updated the plan below. Prior checks for the old plan no longer apply."
                              : "I can do that. I'll check the wallet before preparing the payment."))
                          : result.clarification,
                    ...(result.plan ? { plan: result.plan } : {}),
                    createdAt: now,
                  });
                  const replacedTask = taskReplaced ? result.task : undefined;
                  const retainedMessages =
                    taskReplaced && replacedTask
                      ? retainMessagesForTask(current.messages, replacedTask.id)
                      : current.messages;
                  const nextSession: TaskSession = {
                    version: TASK_SESSION_VERSION,
                    ...(submitOwnerSubject ? { ownerSubject: submitOwnerSubject } : {}),
                    ...(submitWalletAddress ? { ownerWalletAddress: submitWalletAddress } : {}),
                    messages: [...retainedMessages, omnisMessage],
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
                    ...(taskReplaced
                      ? {}
                      : current.servicePurchases
                        ? { servicePurchases: current.servicePurchases }
                        : {}),
                    ...(discovery ? { discovery } : {}),
                  };
                  return nextSession;
                });
                if (operationGenerationRef.current === interpretationGeneration) {
                  setInterpretPending(false);
                  if (interpretAbortRef.current === interpretationAbort) {
                    interpretAbortRef.current = null;
                  }
                }
              })();
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
              disabled={!persistenceEnabled || isCaptureLocked || interpretPending}
              aria-describedby="composer-help"
            />
            <div className="composer-bottom">
              <div className="composer-actions" ref={taskActionsRef}>
                <button
                  ref={taskActionsTriggerRef}
                  className="composer-actions-trigger"
                  type="button"
                  aria-label="Task actions"
                  aria-haspopup="menu"
                  aria-expanded={taskActionsOpen}
                  aria-controls={taskActionsMenuId}
                  title="Task actions"
                  disabled={!persistenceEnabled}
                  onClick={() => {
                    setNewTaskError(undefined);
                    setTaskActionsOpen((open) => !open);
                  }}
                >
                  <Plus size={20} strokeWidth={1.8} aria-hidden="true" />
                </button>
                {taskActionsOpen && (
                  <div
                    ref={taskActionsMenuRef}
                    id={taskActionsMenuId}
                    className="composer-actions-menu"
                    role="menu"
                    aria-label="Task actions"
                  >
                    <button
                      ref={taskActionsItemRef}
                      className="composer-actions-item"
                      type="button"
                      role="menuitem"
                      onClick={() => startNewTask()}
                    >
                      <Plus size={16} aria-hidden="true" />
                      <span>start new task</span>
                    </button>
                  </div>
                )}
              </div>
              <span className="composer-mode">
                <span className="preview-dot" /> task · budget · rules
              </span>
              <button
                className="submit-task"
                type="submit"
                aria-label="Submit task"
                disabled={!persistenceEnabled || isCaptureLocked || interpretPending || !value.trim()}
              >
                <ArrowUp size={20} aria-hidden="true" />
              </button>
            </div>
          </form>

          {newTaskError && (
            <p className="composer-reset-error" role="status">
              {newTaskError}
            </p>
          )}

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
                    disabled={!persistenceEnabled}
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

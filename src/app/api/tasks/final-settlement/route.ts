import {
  extractBearerToken,
  verifyPrivyAccessToken,
} from "@/lib/auth/server";
import {
  hydrateDraftSession,
  hydrateSettlement,
  serializeApproval,
  serializeDraftSession,
  serializeProof,
  serializeSettlement,
  serializeTask,
} from "@/lib/tasks/persistence";
import { getP4ALiveServiceRegistry } from "@/lib/services/server/p4a";
import {
  approveFinalSettlement,
  reconcileFinalSettlementOnchain,
  recordFinalSettlementSubmission,
  recoverLegacyP6BSettlement,
  runFinalSettlementPreflight,
  serializeFinalSettlementAuthorizedExecution,
  serializeFinalSettlementPreflight,
} from "@/lib/settlement/final/service";
import type { TaskSession } from "@/lib/tasks/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const bearerToken = extractBearerToken(request);
  if (!bearerToken) {
    return Response.json(
      { ok: false, error: "authentication required: missing bearer access token" },
      { status: 401 },
    );
  }

  let serverSubject: string;
  try {
    const verified = await verifyPrivyAccessToken(bearerToken);
    serverSubject = verified.userId;
  } catch {
    return Response.json(
      { ok: false, error: "authentication failed: invalid or expired access token" },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json(
        { ok: false, error: "request body must be an object" },
        { status: 400 },
      );
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json(
      { ok: false, error: "request body must be valid JSON" },
      { status: 400 },
    );
  }

  const action =
    typeof body.action === "string" ? body.action.trim() : undefined;
  if (
    !action ||
    !["prepare", "approve", "submit", "reconcile", "recover_legacy"].includes(
      action,
    )
  ) {
    return Response.json(
      {
        ok: false,
        error:
          "valid action required: prepare | approve | submit | reconcile | recover_legacy",
      },
      { status: 400 },
    );
  }

  const clientOwnerSubject =
    typeof body.ownerSubject === "string" ? body.ownerSubject.trim() : undefined;
  if (clientOwnerSubject && clientOwnerSubject !== serverSubject) {
    return Response.json(
      { ok: false, error: "client owner identity does not match authenticated token subject" },
      { status: 403 },
    );
  }

  const registry = getP4ALiveServiceRegistry();
  const session = hydrateDraftSession(JSON.stringify(body.session), registry, {
    expectedOwnerSubject: serverSubject,
  });

  if (!session || !session.task || !session.policy) {
    return Response.json(
      { ok: false, error: "valid owned task session is required" },
      { status: 403 },
    );
  }

  const task = session.task;
  const policy = session.policy;
  const servicePurchases = session.servicePurchases ?? [];
  const isTestModeAllowed =
    process.env.NODE_ENV !== "production" ||
    process.env.ENABLE_P6B_TEST_MODE === "true";
  const rawSettlement =
    body.settlement && typeof body.settlement === "object" && !Array.isArray(body.settlement)
      ? (body.settlement as Record<string, unknown>)
      : undefined;
  const clientRequestedTestMode = Boolean(
    body.testMode ||
      rawSettlement?.testMode ||
      session.settlement?.testMode ||
      session.approval?.testMode,
  );
  if (clientRequestedTestMode && !isTestModeAllowed) {
    return Response.json(
      { ok: false, error: "test mode is not enabled on this deployment" },
      { status: 403 },
    );
  }
  const testMode = isTestModeAllowed && clientRequestedTestMode;
  const authoritativeWallet =
    session.ownerWalletAddress ?? task.ownerWalletAddress;
  if (!authoritativeWallet || !authoritativeWallet.startsWith("0x")) {
    return Response.json(
      { ok: false, error: "task session is missing authoritative primary execution wallet address" },
      { status: 403 },
    );
  }

  const clientWallet =
    typeof body.executionWalletAddress === "string"
      ? body.executionWalletAddress.trim()
      : undefined;
  if (
    clientWallet &&
    clientWallet.toLowerCase() !== authoritativeWallet.toLowerCase()
  ) {
    return Response.json(
      {
        ok: false,
        error: `client execution wallet ${clientWallet} does not match task primary execution wallet ${authoritativeWallet}`,
      },
      { status: 403 },
    );
  }

  const executionWalletAddress = authoritativeWallet as `0x${string}`;

  try {
    if (action === "prepare") {
      const { preflight, settlement } = await runFinalSettlementPreflight({
        task,
        policy,
        servicePurchases,
        executionWalletAddress,
        ownerSubject: serverSubject,
        testMode,
      });

      return Response.json({
        ok: true,
        action: "prepare",
        preflight: serializeFinalSettlementPreflight(preflight),
        settlement: serializeSettlement(settlement),
        testMode,
      });
    }

    if (action === "approve") {
      const preflightResult = await runFinalSettlementPreflight({
        task,
        policy,
        servicePurchases,
        executionWalletAddress,
        ownerSubject: serverSubject,
        testMode,
      });

      if (!preflightResult.preflight.readyForApproval) {
        return Response.json(
          {
            ok: false,
            error: `settlement approval blocked: ${preflightResult.preflight.blockers.join("; ")}`,
            blockers: preflightResult.preflight.blockers,
          },
          { status: 422 },
        );
      }

      let settlementToApprove = session.settlement;
      if (!settlementToApprove && body.settlement) {
        settlementToApprove = hydrateSettlement(body.settlement, policy);
      }
      const settlement = settlementToApprove ?? preflightResult.settlement;
      const { approval, settlement: approvedSettlement, task: settlingTask, authorizedExecution } =
        approveFinalSettlement({
          task,
          policy,
          servicePurchases,
          settlement,
          executionWalletAddress,
          ownerSubject: serverSubject,
          testMode,
        });

      const updatedSession: TaskSession = {
        ...session,
        task: settlingTask,
        approval,
        settlement: approvedSettlement,
      };

      return Response.json({
        ok: true,
        action: "approve",
        approval: serializeApproval(approval),
        settlement: serializeSettlement(approvedSettlement),
        task: serializeTask(settlingTask),
        session: JSON.parse(serializeDraftSession(updatedSession, registry)),
        authorizedExecution: serializeFinalSettlementAuthorizedExecution(authorizedExecution),
      });
    }

    if (action === "submit") {
      const rawTxHash =
        typeof body.transactionHash === "string"
          ? body.transactionHash.trim()
          : undefined;
      if (!rawTxHash || !rawTxHash.startsWith("0x")) {
        return Response.json(
          { ok: false, error: "valid transactionHash required for submission" },
          { status: 400 },
        );
      }

      let settlementToSubmit = session.settlement;
      if (!settlementToSubmit && body.settlement) {
        settlementToSubmit = hydrateSettlement(body.settlement, policy);
      }
      const settlement = settlementToSubmit;
      if (!settlement) {
        return Response.json(
          { ok: false, error: "no active settlement execution exists on this session" },
          { status: 400 },
        );
      }
      const approval = session.approval;
      if (!approval) {
        return Response.json(
          { ok: false, error: "approval record required for settlement submission" },
          { status: 403 },
        );
      }

      const { settlement: confirmingSettlement, task: settlingTask } =
        recordFinalSettlementSubmission({
          task,
          policy,
          settlement,
          approval,
          transactionHash: rawTxHash,
          testMode,
        });
      const updatedSession: TaskSession = {
        ...session,
        task: settlingTask,
        settlement: confirmingSettlement,
      };

      return Response.json({
        ok: true,
        action: "submit",
        settlement: serializeSettlement(confirmingSettlement),
        task: serializeTask(settlingTask),
        session: JSON.parse(serializeDraftSession(updatedSession, registry)),
      });
    }

    if (action === "reconcile") {
      let settlementToReconcile = session.settlement;
      if (!settlementToReconcile && body.settlement) {
        settlementToReconcile = hydrateSettlement(body.settlement, policy);
      }
      let settlement = settlementToReconcile;
      if (!settlement) {
        return Response.json(
          { ok: false, error: "no active settlement execution exists on this session" },
          { status: 400 },
        );
      }
      if (
        typeof body.transactionHash === "string" &&
        body.transactionHash.trim().startsWith("0x")
      ) {
        settlement = {
          ...settlement,
          transactionHash: body.transactionHash.trim(),
        };
      }

      const approval = session.approval;
      if (!approval) {
        return Response.json(
          { ok: false, error: "approval record required for settlement reconciliation" },
          { status: 403 },
        );
      }

      const {
        status: recStatus,
        reconciliationState,
        settlement: recSettlement,
        task: recTask,
        proof,
        message,
      } = await reconcileFinalSettlementOnchain({
        task,
        policy,
        servicePurchases,
        settlement,
        approval,
        testMode,
      });
      const updatedSession: TaskSession = {
        ...session,
        task: recTask,
        settlement: recSettlement,
        ...(proof ? { proof } : {}),
      };

      return Response.json({
        ok: true,
        action: "reconcile",
        status: recStatus,
        reconciliationState,
        message,
        settlement: serializeSettlement(recSettlement),
        task: serializeTask(recTask),
        ...(proof ? { proof: serializeProof(proof) } : {}),
        session: JSON.parse(serializeDraftSession(updatedSession, registry)),
      });
    }
    if (action === "recover_legacy") {
      const rawTxHash =
        typeof body.transactionHash === "string"
          ? body.transactionHash.trim()
          : undefined;
      const HASH_64_HEX_REGEX = /^0x[0-9a-fA-F]{64}$/;
      if (!rawTxHash || !HASH_64_HEX_REGEX.test(rawTxHash)) {
        return Response.json(
          {
            ok: false,
            error:
              "Valid 66-character 0x hexadecimal transaction hash is required for recovery",
          },
          { status: 400 },
        );
      }

      const settlementToRecover = session.settlement;
      if (!settlementToRecover) {
        return Response.json(
          {
            ok: false,
            error:
              "No persisted settlement execution exists on this session to recover",
          },
          { status: 400 },
        );
      }

      const approvalToRecover = session.approval;
      if (!approvalToRecover) {
        return Response.json(
          {
            ok: false,
            error:
              "No persisted approval record exists on this session to recover",
          },
          { status: 400 },
        );
      }

      const recoveryResult = await recoverLegacyP6BSettlement({
        task,
        policy,
        servicePurchases,
        settlement: settlementToRecover,
        approval: approvalToRecover,
        proof: session.proof,
        transactionHash: rawTxHash,
        executionWalletAddress,
        ownerSubject: serverSubject,
      });

      const updatedSession: TaskSession = {
        ...session,
        task: recoveryResult.task,
        approval: recoveryResult.approval,
        settlement: recoveryResult.settlement,
        proof: recoveryResult.proof,
      };

      return Response.json({
        ok: true,
        action: "recover_legacy",
        status: recoveryResult.status,
        reconciliationState: recoveryResult.reconciliationState,
        message: recoveryResult.message,
        settlement: serializeSettlement(recoveryResult.settlement),
        approval: serializeApproval(recoveryResult.approval),
        task: serializeTask(recoveryResult.task),
        proof: serializeProof(recoveryResult.proof),
        session: JSON.parse(serializeDraftSession(updatedSession, registry)),
      });
    }

    return Response.json({ ok: false, error: "unsupported action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "final settlement failed";
    return Response.json(
      { ok: false, error: message },
      { status: 422 },
    );
  }
}

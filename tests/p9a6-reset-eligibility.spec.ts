import { expect, test } from "@playwright/test";
import { money } from "../src/lib/domain";
import { canStartNewTask } from "../src/lib/tasks/reset-eligibility";
import type { TaskSession } from "../src/lib/tasks/session";

const baseSession = (): TaskSession => ({
  version: 5,
  messages: [],
});

test.describe("P9A.6 new-task reset eligibility", () => {
  test("allows a fresh session", () => {
    expect(canStartNewTask(baseSession(), false)).toEqual({ allowed: true });
  });

  test("allows a draft task", () => {
    expect(
      canStartNewTask(
        {
          ...baseSession(),
          task: {
            id: "task-draft",
            ownerId: "owner",
            type: "pay",
            status: "draft",
            finalPaymentApprovalRequired: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        false,
      ),
    ).toEqual({ allowed: true });
  });

  test("blocks execution and recovery states with concise copy", () => {
    const session: TaskSession = {
      ...baseSession(),
      task: {
        id: "task-settling",
        ownerId: "owner",
        type: "pay",
        status: "settling",
        finalPaymentApprovalRequired: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      settlement: {
        id: "settlement",
        taskId: "task-settling",
        provider: "test",
        amount: money("1", "USDC"),
        recipient: "0x1234567890abcdef",
        network: "Arc Testnet",
        approvalRequired: false,
        policySnapshot: {
          taskId: "task-settling",
          allowedServiceCategories: [],
          allowedAssets: ["USDC"],
          allowedNetworks: ["Arc Testnet"],
          finalPaymentApprovalRequired: false,
        },
        status: "confirming",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    expect(canStartNewTask(session, false)).toEqual({
      allowed: false,
      reason: "This task is still settling. Finish or reconcile it before starting a new task.",
    });
    expect(canStartNewTask(baseSession(), true)).toEqual({
      allowed: false,
      reason: "This task is still settling. Finish or reconcile it before starting a new task.",
    });
  });

  test("blocks service payment and recovery states", () => {
    expect(
      canStartNewTask(
        {
          ...baseSession(),
          servicePurchases: [
            {
              status: "paying",
              recoveryState: {
                mode: "read_only_reconcile",
                stage: "submitted",
                requestId: "request",
                settlementSent: "unknown",
                paymentSettled: "unknown",
                retryable: false,
                message: "reconcile",
              },
            } as never,
          ],
        },
        false,
      ),
    ).toEqual({
      allowed: false,
      reason: "This task is still settling. Finish or reconcile it before starting a new task.",
    });
  });

  test("fails closed for every in-flight task and settlement status", () => {
    for (const status of ["running", "settling"] as const) {
      expect(
        canStartNewTask(
          {
            ...baseSession(),
            task: {
              id: `task-${status}`,
              ownerId: "owner",
              type: "pay",
              status,
              finalPaymentApprovalRequired: false,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
          false,
        ),
      ).toEqual({ allowed: false, reason: expect.any(String) });
    }
    for (const status of [
      "prepared",
      "awaiting_approval",
      "submitting",
      "submitted",
      "confirming",
      "confirmation_delayed",
    ] as const) {
      expect(
        canStartNewTask(
          {
            ...baseSession(),
            settlement: {
              id: "settlement",
              taskId: "task",
              provider: "test",
              amount: money("1", "USDC"),
              recipient: "0x1234567890abcdef",
              network: "Arc Testnet",
              approvalRequired: false,
              policySnapshot: {
                taskId: "task",
                allowedServiceCategories: [],
                allowedAssets: ["USDC"],
                allowedNetworks: ["Arc Testnet"],
                finalPaymentApprovalRequired: false,
              },
              status,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
          false,
        ),
      ).toEqual({ allowed: false, reason: expect.any(String) });
    }
  });

  test("allows a completed task only after confirmed settlement", () => {
    const task = {
      id: "task-complete",
      ownerId: "owner",
      type: "pay" as const,
      status: "completed" as const,
      finalPaymentApprovalRequired: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const policy = {
      taskId: task.id,
      allowedServiceCategories: [],
      allowedAssets: ["USDC"],
      allowedNetworks: ["Arc Testnet"],
      finalPaymentApprovalRequired: false,
    };
    expect(
      canStartNewTask(
        {
          ...baseSession(),
          task,
          policy,
          settlement: {
            id: "settlement",
            taskId: task.id,
            provider: "test",
            amount: money("1", "USDC"),
            recipient: "0x1234567890abcdef",
            network: "Arc Testnet",
            approvalRequired: false,
            policySnapshot: policy,
            status: "confirmed",
            transactionHash: "0xhash",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        false,
      ),
    ).toEqual({ allowed: true });
  });
});

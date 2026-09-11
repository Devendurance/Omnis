import { expect, test } from "@playwright/test";
import {
  authorizeServiceSpend,
  createFinancialTask,
  createServiceDescriptor,
  createTaskPolicy,
  evaluateServiceSpend,
  formatMoney,
  money,
  transitionTask,
  type FinancialTask,
  type ServiceDescriptor,
  type ServicePurchase,
  type TaskPolicy,
} from "../src/lib/domain";
import {
  beginTaskExecution,
  getTaskBudgetState,
} from "../src/lib/tasks/runtime";
import {
  discoverServices,
  SERVICE_REGISTRY_VERSION,
  createServiceRegistry,
  resolveRequiredCapability,
  selectServiceCandidate,
  serviceRegistry,
  type ServiceRegistry,
} from "../src/lib/services";
import {
  hydrateDraftSession,
  serializeDraftSession,
} from "../src/lib/tasks/persistence";
import { TASK_SESSION_VERSION, type TaskSession } from "../src/lib/tasks/session";

const NOW = "2026-09-07T12:00:00.000Z";
const NETWORK = "local-preview";
const RECIPIENT = "0x1234567890abcdef";

function makePolicy(
  taskId = "task-p3",
  overrides: Partial<TaskPolicy> = {},
): TaskPolicy {
  return createTaskPolicy({
    taskId,
    maxServiceSpend: money("0.05", "USD"),
    maxPerService: money("0.05", "USD"),
    allowedServiceCategories: ["wallet-risk"],
    allowedServiceNetworks: [NETWORK],
    allowedAssets: ["USD", "USDC"],
    allowedNetworks: [],
    finalPaymentApprovalRequired: true,
    ...overrides,
  });
}

function makeTask(
  policy = makePolicy(),
  status: "planned" | "running" = "planned",
): FinancialTask {
  const draft = createFinancialTask(
    {
      id: policy.taskId,
      ownerId: "owner-p3",
      type: "pay_with_check",
      originalIntent: "P3 service discovery",
      recipient: RECIPIENT,
      paymentAmount: money("50", "USDC"),
      purpose: "contractor payment",
      serviceBudget: policy.maxServiceSpend,
      perServiceCap: policy.maxPerService,
      finalPaymentApprovalRequired: true,
    },
    NOW,
  );
  const planned = transitionTask(draft, "planned", { now: NOW });
  return status === "running"
    ? beginTaskExecution(planned, policy, NOW)
    : planned;
}

function makeService(
  overrides: Partial<Parameters<typeof createServiceDescriptor>[0]> = {},
): ServiceDescriptor {
  return createServiceDescriptor({
    id: "wallet-risk-service",
    name: "Wallet risk service",
    capability: "wallet-risk",
    category: "wallet-risk",
    description: "A deterministic development catalog descriptor.",
    endpoint: "catalog://wallet-risk-service",
    price: money("0.003", "USD"),
    network: NETWORK,
    paymentProtocol: "x402",
    inputSchema: {},
    outputSchema: {},
    ...overrides,
  });
}

function sessionWithDiscovery(
  task: FinancialTask,
  policy: TaskPolicy,
  selectedServiceId = "catalog-wallet-risk",
): TaskSession {
  return {
    version: TASK_SESSION_VERSION,
    messages: [],
    task,
    policy,
    discovery: {
      requiredCapability: resolveRequiredCapability(task)!,
      selectedServiceId,
      discoveredAt: NOW,
      registryVersion: SERVICE_REGISTRY_VERSION,
    },
  };
}

function discoveryInput(
  task: FinancialTask,
  policy: TaskPolicy,
  registry: ServiceRegistry = serviceRegistry,
  requiredCapability = "wallet-risk",
  existingPurchases: readonly ServicePurchase[] = [],
) {
  return {
    task,
    policy,
    requiredCapability,
    registry,
    existingPurchases,
  };
}

test.describe("P3 service directory and deterministic discovery", () => {
  test("registry exposes capability, availability, network, protocol, and price filters", () => {
    expect(serviceRegistry.searchByCapability("WALLET-RISK").map((service) => service.id)).toEqual([
      "catalog-wallet-risk",
    ]);
    expect(serviceRegistry.filterByAvailability("available")).toHaveLength(2);
    expect(serviceRegistry.filterBySupportedNetwork(NETWORK)).toHaveLength(2);
    expect(serviceRegistry.filterByPaymentProtocol("x402")).toHaveLength(2);
    expect(
      serviceRegistry.listServices({ order: "price" }).map((service) => service.id),
    ).toEqual(["catalog-wallet-risk", "catalog-wallet-activity"]);
  });

  test("wallet-risk task finds compatible services", () => {
    const policy = makePolicy();
    const task = makeTask(policy);
    const result = discoverServices(discoveryInput(task, policy));

    expect(result.selectableCandidates).toHaveLength(2);
    expect(
      result.selectableCandidates.map((candidate) => candidate.descriptor.capability),
    ).toEqual(["wallet-risk", "wallet-activity"]);
    expect(result.selectableCandidates[0].descriptor.id).toBe(
      "catalog-wallet-risk",
    );
    expect(
      result.selectableCandidates.every(
        (candidate) => candidate.descriptor.catalogOnly,
      ),
    ).toBe(true);
  });

  test("unsupported capability returns no selectable candidates", () => {
    const policy = makePolicy();
    const task = makeTask(policy);
    const result = discoverServices(
      discoveryInput(task, policy, serviceRegistry, "wallet-reputation"),
    );

    expect(result.selectableCandidates).toEqual([]);
    expect(result.candidates).toHaveLength(2);
    expect(
      result.candidates.every((candidate) =>
        candidate.reasonCodes.includes("UNSUPPORTED_CAPABILITY"),
      ),
    ).toBe(true);
  });

  test("unavailable service is excluded from selectable candidates", () => {
    const policy = makePolicy();
    const task = makeTask(policy);
    const registry = createServiceRegistry([
      makeService({ id: "service-unavailable", status: "unavailable" }),
      makeService({ id: "service-available", price: money("0.004", "USD") }),
    ]);
    const result = discoverServices(discoveryInput(task, policy, registry));

    expect(result.selectableCandidates.map((candidate) => candidate.descriptor.id)).toEqual([
      "service-available",
    ]);
    expect(result.rejectedCandidates[0].reasonCodes).toContain(
      "DENY_SERVICE_UNAVAILABLE",
    );
  });

  test("over-budget service is rejected", () => {
    const policy = makePolicy("task-over-budget", {
      maxPerService: money("0.10", "USD"),
    });
    const task = makeTask(policy);
    const registry = createServiceRegistry([
      makeService({ price: money("0.06", "USD") }),
    ]);
    const result = discoverServices(discoveryInput(task, policy, registry));

    expect(result.selectableCandidates).toEqual([]);
    expect(result.candidates[0].reasonCodes).toContain(
      "DENY_TOTAL_BUDGET_EXCEEDED",
    );
  });

  test("per-service-cap violation is rejected", () => {
    const policy = makePolicy("task-cap", {
      maxPerService: money("0.002", "USD"),
    });
    const task = makeTask(policy);
    const registry = createServiceRegistry([
      makeService({ price: money("0.003", "USD") }),
    ]);
    const result = discoverServices(discoveryInput(task, policy, registry));

    expect(result.selectableCandidates).toEqual([]);
    expect(result.candidates[0].reasonCodes).toContain(
      "DENY_PER_SERVICE_CAP_EXCEEDED",
    );
  });

  test("disallowed network and category are rejected", () => {
    const networkPolicy = makePolicy("task-network", {
      allowedServiceNetworks: ["another-network"],
    });
    const networkTask = makeTask(networkPolicy);
    const networkResult = discoverServices(
      discoveryInput(
        networkTask,
        networkPolicy,
        createServiceRegistry([makeService()]),
      ),
    );
    expect(networkResult.candidates[0].reasonCodes).toContain(
      "DENY_NETWORK_NOT_ALLOWED",
    );

    const categoryPolicy = makePolicy("task-category", {
      allowedServiceCategories: ["identity"],
    });
    const categoryTask = makeTask(categoryPolicy);
    const categoryResult = discoverServices(
      discoveryInput(
        categoryTask,
        categoryPolicy,
        createServiceRegistry([makeService()]),
      ),
    );
    expect(categoryResult.candidates[0].reasonCodes).toContain(
      "DENY_SERVICE_CATEGORY_NOT_ALLOWED",
    );
  });

  test("cheapest valid candidate wins", () => {
    const policy = makePolicy("task-cheapest");
    const task = makeTask(policy);
    const registry = createServiceRegistry([
      makeService({ id: "service-expensive", price: money("0.004", "USD") }),
      makeService({ id: "service-cheap", price: money("0.003", "USD") }),
    ]);
    const result = selectServiceCandidate(discoveryInput(task, policy, registry));

    expect(result.selected?.descriptor.id).toBe("service-cheap");
    expect(result.alternates.map((candidate) => candidate.descriptor.id)).toEqual([
      "service-expensive",
    ]);
  });

  test("equal prices use stable service-id tie-breaking", () => {
    const policy = makePolicy("task-tie");
    const task = makeTask(policy);
    const registry = createServiceRegistry([
      makeService({ id: "service-z", price: money("0.003", "USD") }),
      makeService({ id: "service-a", price: money("0.003", "USD") }),
    ]);
    const result = selectServiceCandidate(discoveryInput(task, policy, registry));

    expect(result.selected?.descriptor.id).toBe("service-a");
  });

  test("selection does not reserve budget", () => {
    const policy = makePolicy("task-selection");
    const task = makeTask(policy);
    const result = selectServiceCandidate(discoveryInput(task, policy));

    expect(result.selected).toBeDefined();
    expect(result.selected?.budgetEvaluation?.decision).toBe("ALLOW");
    expect(formatMoney(getTaskBudgetState(task, policy).reservedSpend)).toBe("0");
  });

  test("only authorizeServiceSpend creates a reservation", () => {
    const policy = makePolicy("task-authorization");
    const task = makeTask(policy, "running");
    const service = makeService();
    const evaluation = evaluateServiceSpend({
      task,
      policy,
      service,
      quotedPrice: service.price,
      existingPurchases: [],
    });
    const selection = selectServiceCandidate(discoveryInput(task, policy));

    expect(evaluation.decision).toBe("ALLOW");
    expect(selection.selected).toBeDefined();
    expect(formatMoney(getTaskBudgetState(task, policy).reservedSpend)).toBe("0");

    const authorized = authorizeServiceSpend({
      task,
      policy,
      service,
      quotedPrice: service.price,
      existingPurchases: [],
    });
    expect(authorized.purchase?.status).toBe("approved");
    expect(formatMoney(authorized.reservedSpend)).toBe("0.003");
  });

  test("selected service survives refresh when still in registry", () => {
    const policy = makePolicy("task-refresh");
    const task = makeTask(policy);
    const hydrated = hydrateDraftSession(
      serializeDraftSession(sessionWithDiscovery(task, policy)),
    );

    expect(hydrated?.discovery?.selectedServiceId).toBe("catalog-wallet-risk");
    expect(hydrated?.discovery?.registryVersion).toBe(SERVICE_REGISTRY_VERSION);
  });

  test("stale service selection is safely cleared on hydration", () => {
    const policy = makePolicy("task-stale");
    const task = makeTask(policy);
    const raw = serializeDraftSession(sessionWithDiscovery(task, policy));
    const currentRegistry = createServiceRegistry([], SERVICE_REGISTRY_VERSION);
    const hydrated = hydrateDraftSession(raw, currentRegistry);

    expect(hydrated).not.toBeNull();
    expect(hydrated?.discovery?.requiredCapability).toBe("wallet-activity");
    expect(hydrated?.discovery?.selectedServiceId).toBeUndefined();
  });
});

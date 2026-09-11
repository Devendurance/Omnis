import { raiseDomainError } from "../domain/errors";
import {
  compareMoney,
  money,
  parseMoney,
  serializeMoney,
  type SerializedMoney,
} from "../domain/money";
import { createServiceDescriptor } from "../domain/services/factory";
import type {
  ServiceDescriptor,
  ServiceEnvironment,
} from "../domain/types";
import { createWalletActivityServiceDescriptor } from "./wallet-activity-descriptor";

export const SERVICE_REGISTRY_VERSION = "p3-catalog-v1" as const;

export type ServiceRegistryOrder = "id" | "price";
export type ServiceAvailability = ServiceDescriptor["status"];
export type ServicePaymentProtocol = ServiceDescriptor["paymentProtocol"];

export type ServiceRegistry = Readonly<{
  version: string;
  listServices(options?: Readonly<{ order?: ServiceRegistryOrder }>): readonly ServiceDescriptor[];
  getService(id: string): ServiceDescriptor | undefined;
  searchByCapability(capability: string): readonly ServiceDescriptor[];
  filterByAvailability(
    availability: ServiceAvailability,
  ): readonly ServiceDescriptor[];
  filterByNetwork(network: string): readonly ServiceDescriptor[];
  filterBySupportedNetwork(network: string): readonly ServiceDescriptor[];

  filterByPaymentProtocol(
    protocol: ServicePaymentProtocol,
  ): readonly ServiceDescriptor[];
}>;
export type SerializedServiceDescriptor = Omit<
  ServiceDescriptor,
  "price" | "paymentAmount"
> & {
  price: SerializedMoney;
  paymentAmount?: SerializedMoney;
};

export type SerializedServiceRegistry = Readonly<{
  version: string;
  services: readonly SerializedServiceDescriptor[];
}>;

export function serializeServiceDescriptor(
  service: ServiceDescriptor,
): SerializedServiceDescriptor {
  return {
    id: service.id,
    name: service.name,
    capability: service.capability,
    category: service.category,
    description: service.description,
    endpoint: service.endpoint,
    price: serializeMoney(service.price),
    ...(service.paymentAmount
      ? { paymentAmount: serializeMoney(service.paymentAmount) }
      : {}),
    network: service.network,
    paymentProtocol: service.paymentProtocol,
    inputSchema: service.inputSchema,
    outputSchema: service.outputSchema,
    status: service.status,
    environment: service.environment,
    catalogOnly: service.catalogOnly,
  };
}

export function serializeServiceRegistry(
  registry: ServiceRegistry,
): SerializedServiceRegistry {
  return Object.freeze({
    version: registry.version,
    services: Object.freeze(
      registry.listServices().map(serializeServiceDescriptor),
    ),
  });
}

function registryRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return raiseDomainError("INVALID_SERVICE_REGISTRY", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function registryString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return raiseDomainError("INVALID_SERVICE_REGISTRY", `${field} is required`);
  }
  return value.trim();
}

export function hydrateServiceRegistry(
  value: unknown,
): ServiceRegistry {
  const candidate = registryRecord(value, "registry");
  if (!Array.isArray(candidate.services)) {
    return raiseDomainError(
      "INVALID_SERVICE_REGISTRY",
      "registry services must be an array",
    );
  }
  const services = candidate.services.map((entry, index) => {
    const service = registryRecord(entry, `registry.services[${index}]`);
    const priceValue = registryRecord(
      service.price,
      `registry.services[${index}].price`,
    );
    const paymentAmountValue =
      service.paymentAmount === undefined
        ? undefined
        : registryRecord(
            service.paymentAmount,
            `registry.services[${index}].paymentAmount`,
          );
    const inputSchema = registryRecord(
      service.inputSchema,
      `registry.services[${index}].inputSchema`,
    );
    const outputSchema = registryRecord(
      service.outputSchema,
      `registry.services[${index}].outputSchema`,
    );
    const status = service.status;
    if (status !== "available" && status !== "unavailable") {
      return raiseDomainError(
        "INVALID_SERVICE_REGISTRY",
        `registry.services[${index}].status is invalid`,
      );
    }
    const environment = service.environment;
    if (
      environment !== "development" &&
      environment !== "testnet" &&
      environment !== "production"
    ) {
      return raiseDomainError(
        "INVALID_SERVICE_REGISTRY",
        `registry.services[${index}].environment is invalid`,
      );
    }
    if (typeof service.catalogOnly !== "boolean") {
      return raiseDomainError(
        "INVALID_SERVICE_REGISTRY",
        `registry.services[${index}].catalogOnly is invalid`,
      );
    }
    return createServiceDescriptor({
      id: registryString(service.id, `registry.services[${index}].id`),
      name: registryString(service.name, `registry.services[${index}].name`),
      capability: registryString(
        service.capability,
        `registry.services[${index}].capability`,
      ),
      category: registryString(
        service.category,
        `registry.services[${index}].category`,
      ),
      description: registryString(
        service.description,
        `registry.services[${index}].description`,
      ),
      endpoint: registryString(
        service.endpoint,
        `registry.services[${index}].endpoint`,
      ),
      price: parseMoney(
        registryString(priceValue.amount, `registry.services[${index}].price.amount`),
        registryString(priceValue.asset, `registry.services[${index}].price.asset`),
        priceValue.decimals as number,
      ),
      ...(paymentAmountValue
        ? {
            paymentAmount: parseMoney(
              registryString(
                paymentAmountValue.amount,
                `registry.services[${index}].paymentAmount.amount`,
              ),
              registryString(
                paymentAmountValue.asset,
                `registry.services[${index}].paymentAmount.asset`,
              ),
              paymentAmountValue.decimals as number,
            ),
          }
        : {}),
      network: registryString(
        service.network,
        `registry.services[${index}].network`,
      ),
      paymentProtocol: service.paymentProtocol === "x402"
        ? "x402"
        : raiseDomainError(
            "INVALID_SERVICE_REGISTRY",
            `registry.services[${index}].paymentProtocol is invalid`,
          ),
      inputSchema,
      outputSchema,
      status,
      environment: environment as ServiceEnvironment,
      catalogOnly: service.catalogOnly,
    });
  });
  return createServiceRegistry(
    services,
    registryString(candidate.version, "registry.version"),
  );
}

function normalized(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return raiseDomainError("INVALID_SERVICE_REGISTRY_QUERY", `${field} is required`);
  }
  return value.trim().toLowerCase();
}

function compareText(left: string, right: string): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareServicesById(
  left: ServiceDescriptor,
  right: ServiceDescriptor,
): -1 | 0 | 1 {
  return compareText(left.id, right.id);
}

function compareServicesByPrice(
  left: ServiceDescriptor,
  right: ServiceDescriptor,
): -1 | 0 | 1 {
  const assetOrder = compareText(left.price.asset, right.price.asset);
  if (assetOrder !== 0) return assetOrder;
  const priceOrder = compareMoney(left.price, right.price);
  if (priceOrder !== 0) return priceOrder;
  return compareServicesById(left, right);
}

function sortedServices(
  services: readonly ServiceDescriptor[],
  order: ServiceRegistryOrder = "id",
): readonly ServiceDescriptor[] {
  const copy = [...services];
  copy.sort(order === "price" ? compareServicesByPrice : compareServicesById);
  return Object.freeze(copy);
}
export function createServiceRegistry(
  services: readonly ServiceDescriptor[],
  version: string = SERVICE_REGISTRY_VERSION,
): ServiceRegistry {
  if (typeof version !== "string" || !version.trim()) {
    return raiseDomainError(
      "INVALID_SERVICE_REGISTRY_VERSION",
      "service registry version is required",
    );
  }
  const byId = new Map<string, ServiceDescriptor>();
  for (const service of services) {
    if (byId.has(service.id)) {
      return raiseDomainError(
        "DUPLICATE_SERVICE_ID",
        `service registry contains duplicate id ${service.id}`,
      );
    }
    byId.set(service.id, service);
  }

  const source = Object.freeze([...services]);
  const listServices = (options: Readonly<{ order?: ServiceRegistryOrder }> = {}) =>
    sortedServices(source, options.order);
  const filter = (predicate: (service: ServiceDescriptor) => boolean) =>
    sortedServices(source.filter(predicate));

  return Object.freeze({
    version: version.trim(),
    listServices,
    getService: (id: string) => byId.get(id.trim()),
    searchByCapability: (capability: string) => {
      const value = normalized(capability, "service capability");
      return filter((service) => service.capability.toLowerCase() === value);
    },
    filterByAvailability: (availability: ServiceAvailability) =>
      filter((service) => service.status === availability),
    filterByNetwork: (network: string) => {
      const value = normalized(network, "service network");
      return filter((service) => service.network.toLowerCase() === value);
    },
    filterBySupportedNetwork: (network: string) => {
      const value = normalized(network, "supported service network");
      return filter((service) => service.network.toLowerCase() === value);
    },
    filterByPaymentProtocol: (protocol: ServicePaymentProtocol) =>
      filter((service) => service.paymentProtocol === protocol),
  });
}
export type ServiceDirectoryQuery = Readonly<{
  capabilityPrefix?: string;
  query?: string;
}>;

export function filterServiceDirectory(
  services: readonly ServiceDescriptor[],
  options: ServiceDirectoryQuery = {},
): readonly ServiceDescriptor[] {
  const capabilityPrefix = options.capabilityPrefix?.trim().toLowerCase();
  const query = options.query?.trim().toLowerCase();
  return sortedServices(
    services.filter((service) => {
      if (
        capabilityPrefix &&
        !service.capability.toLowerCase().startsWith(capabilityPrefix)
      ) {
        return false;
      }
      if (!query) return true;
      return [service.name, service.capability, service.description]
        .join(" ")
        .toLowerCase()
        .includes(query);
    }),
    "price",
  );
}


export const SERVICE_CATALOG: readonly ServiceDescriptor[] = Object.freeze([
  createServiceDescriptor({
    id: "catalog-wallet-risk",
    name: "Wallet risk signal",
    capability: "wallet-risk",
    category: "wallet-risk",
    description: "Development catalog entry for a wallet risk check.",
    endpoint: "catalog://wallet-risk",
    price: money("0.003", "USD"),
    network: "local-preview",
    paymentProtocol: "x402",
    inputSchema: { wallet: { type: "string" } },
    outputSchema: { risk: { type: "string" } },
    status: "available",
    environment: "development",
    catalogOnly: true,
  }),
  createServiceDescriptor({
    id: "catalog-wallet-activity",
    name: "Wallet activity summary",
    capability: "wallet-activity",
    category: "wallet-risk",
    description: "Development catalog entry for wallet activity context.",
    endpoint: "catalog://wallet-activity",
    price: money("0.004", "USD"),
    network: "local-preview",
    paymentProtocol: "x402",
    inputSchema: { wallet: { type: "string" } },
    outputSchema: { activity: { type: "array" } },
    status: "available",
    environment: "development",
    catalogOnly: true,
  }),
]);

export const P4A_LIVE_SERVICE_REGISTRY_VERSION = "p4a-live-v1" as const;

export function createLiveServiceRegistry(
  status: ServiceDescriptor["status"] = "unavailable",
): ServiceRegistry {
  return createServiceRegistry(
    [...SERVICE_CATALOG, createWalletActivityServiceDescriptor(status)],
    P4A_LIVE_SERVICE_REGISTRY_VERSION,
  );
}

export const serviceRegistry = createServiceRegistry(SERVICE_CATALOG);

export function getServiceRegistry(): ServiceRegistry {
  return serviceRegistry;
}

export function listServices(
  options: Readonly<{ order?: ServiceRegistryOrder }> = {},
): readonly ServiceDescriptor[] {
  return serviceRegistry.listServices(options);
}

export function getServiceById(id: string): ServiceDescriptor | undefined {
  return serviceRegistry.getService(id);
}

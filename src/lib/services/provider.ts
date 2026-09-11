import type { ServiceDescriptor } from "../domain";

export type ServiceProviderInspection = Readonly<{
  availability: ServiceDescriptor["status"];
  environment: ServiceDescriptor["environment"];
  observedAt?: string;
  metadata?: Readonly<Record<string, string>>;
}>;

export type ServiceProviderInspectionInput = Readonly<{
  descriptor: ServiceDescriptor;
}>;

/**
 * P3 only describes provider inspection. It intentionally has no payment or
 * execution method; P4 can add an adapter without changing discovery.
 */
export interface ServiceProviderAdapter {
  supports(descriptor: ServiceDescriptor): boolean;
  inspect(
    input: ServiceProviderInspectionInput,
  ): ServiceProviderInspection | Promise<ServiceProviderInspection>;
}

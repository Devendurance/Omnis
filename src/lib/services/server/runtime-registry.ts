import "server-only";

import { createLiveServiceRegistry, type ServiceRegistry } from "../registry";
import {
  inspectP4AEnvironment,
  type P4AEnvironment,
} from "../hedera-x402/config";

export function getP4ALiveServiceRegistry(
  env: P4AEnvironment = process.env,
): ServiceRegistry {
  const demoEnabled =
    env.OMNIS_DEMO_PURCHASES_ENABLED?.trim() === "true" &&
    (env.OMNIS_DEMO_ALLOWLIST?.trim() ?? "") !== "";
  const status =
    env.NODE_ENV === "production" && !demoEnabled
      ? "unavailable"
      : inspectP4AEnvironment(env).configured
        ? "available"
        : "unavailable";
  return createLiveServiceRegistry(status);
}

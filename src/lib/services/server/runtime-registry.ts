import "server-only";

import { createLiveServiceRegistry, type ServiceRegistry } from "../registry";
import {
  inspectP4AEnvironment,
  type P4AEnvironment,
} from "../hedera-x402/config";
import { resolveP4ALiveServiceStatus } from "./demo-guard";

export function getP4ALiveServiceRegistry(
  env: P4AEnvironment = process.env,
): ServiceRegistry {
  return createLiveServiceRegistry(
    resolveP4ALiveServiceStatus(env, inspectP4AEnvironment(env).configured),
  );
}

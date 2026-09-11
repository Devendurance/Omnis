import { getP4ALiveServiceRegistry } from "@/lib/services/server/p4a";
import { serializeServiceRegistry } from "@/lib/services/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const registry = getP4ALiveServiceRegistry();
  return Response.json(serializeServiceRegistry(registry), {
    headers: { "cache-control": "no-store" },
  });
}

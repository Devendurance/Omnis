import { handleWalletActivityRequest } from "@/lib/services/server/p4a";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleWalletActivityRequest(request);
}

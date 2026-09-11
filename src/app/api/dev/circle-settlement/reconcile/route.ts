import { extractBearerToken, verifyPrivyAccessToken } from "@/lib/auth/server";
import { getArcPublicClient, ARC_TESTNET_EXPLORER_URL } from "@/lib/settlement";
import type { Hash } from "viem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const bearerToken = extractBearerToken(request);
  if (!bearerToken) {
    return Response.json(
      { ok: false, error: "Authentication required: missing bearer access token" },
      { status: 401 },
    );
  }

  let serverSubject: string;
  try {
    const verified = await verifyPrivyAccessToken(bearerToken);
    serverSubject = verified.userId;
  } catch {
    return Response.json(
      { ok: false, error: "Authentication failed: invalid or expired access token" },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json(
        { ok: false, error: "Request body must be an object" },
        { status: 400 },
      );
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json(
      { ok: false, error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const clientOwnerSubject =
    typeof body.ownerSubject === "string" ? body.ownerSubject.trim() : undefined;
  if (clientOwnerSubject && clientOwnerSubject !== serverSubject) {
    return Response.json(
      {
        ok: false,
        error: "Client owner identity does not match authenticated token subject",
      },
      { status: 403 },
    );
  }

  const txHash =
    typeof body.txHash === "string" ? body.txHash.trim() : undefined;
  if (!txHash || !txHash.startsWith("0x")) {
    return Response.json(
      { ok: false, error: "Valid transaction hash required" },
      { status: 400 },
    );
  }

  const client = getArcPublicClient();
  try {
    const receipt = await client.getTransactionReceipt({
      hash: txHash as Hash,
    });

    if (!receipt) {
      return Response.json(
        {
          ok: true,
          status: "pending",
          txHash,
          explorerUrl: `${ARC_TESTNET_EXPLORER_URL}/tx/${txHash}`,
          message: "Transaction is pending on Arc Testnet",
        },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const confirmed = receipt.status === "success";
    return Response.json(
      {
        ok: true,
        status: confirmed ? "confirmed" : "reverted",
        confirmedStatus: confirmed ? "confirmed" : "reverted",
        txHash,
        explorerUrl: `${ARC_TESTNET_EXPLORER_URL}/tx/${txHash}`,
        blockNumber: Number(receipt.blockNumber),
        gasUsed: receipt.gasUsed.toString(),
        message: confirmed
          ? `Transaction confirmed in block ${receipt.blockNumber}`
          : "Transaction reverted onchain",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        ok: false,
        error: `Failed to query transaction receipt: ${msg}`,
      },
      { status: 500 },
    );
  }
}

import { extractBearerToken, verifyPrivyAccessToken } from "@/lib/auth/server";
import {
  getArcPublicClient,
  getArcUsdcBalance,
  isArcTestnetChainId,
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_NAME,
  ARC_TESTNET_USDC_DECIMALS,
  ARC_TESTNET_USDC_SYMBOL,
} from "@/lib/settlement";
import { formatMoney, moneyZero, parseMoney } from "@/lib/domain/money";

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

  const walletAddress =
    typeof body.walletAddress === "string" ? body.walletAddress.trim() : undefined;
  if (!walletAddress || !walletAddress.startsWith("0x")) {
    return Response.json(
      { ok: false, error: "Valid execution wallet address required" },
      { status: 400 },
    );
  }

  const requestedAmountStr =
    typeof body.requestedAmount === "string"
      ? body.requestedAmount.trim()
      : "0.01";
  const requestedAmount = parseMoney(
    requestedAmountStr,
    ARC_TESTNET_USDC_SYMBOL,
    ARC_TESTNET_USDC_DECIMALS,
  );

  const recipient =
    typeof body.recipient === "string"
      ? body.recipient.trim()
      : "0x1234567890abcdef1234567890abcdef12345678";

  const blockers: string[] = [];
  let arcTestnetReachable = false;
  let currentArcUsdcBalance = moneyZero(
    ARC_TESTNET_USDC_SYMBOL,
    ARC_TESTNET_USDC_DECIMALS,
  );

  const client = getArcPublicClient();
  try {
    const chainId = await client.getChainId();
    if (isArcTestnetChainId(chainId)) {
      arcTestnetReachable = true;
    } else {
      blockers.push(`Connected chainId ${chainId} does not match Arc Testnet ${ARC_TESTNET_CHAIN_ID}`);
    }
  } catch (err) {
    blockers.push(`Arc Testnet RPC unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (arcTestnetReachable) {
    try {
      currentArcUsdcBalance = await getArcUsdcBalance(
        walletAddress as `0x${string}`,
        client,
      );
    } catch (err) {
      blockers.push(`Failed to read Arc USDC balance: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!recipient.startsWith("0x")) {
    blockers.push("Invalid destination recipient address");
  }

  const sufficientBalance = currentArcUsdcBalance.units >= requestedAmount.units;
  if (!sufficientBalance) {
    blockers.push(
      `Insufficient Arc USDC wallet balance: available ${formatMoney(currentArcUsdcBalance)}, requested ${formatMoney(requestedAmount)}`,
    );
  }

  const readyForOneTestSettlement =
    blockers.length === 0 && arcTestnetReachable && sufficientBalance;

  return Response.json(
    {
      ok: true,
      preflight: {
        authenticatedSubject: serverSubject,
        executionWalletAddress: walletAddress,
        walletReady: true,
        arcTestnetReachable,
        currentArcUsdcBalance: {
          amount: currentArcUsdcBalance.units.toString(),
          asset: currentArcUsdcBalance.asset,
          decimals: currentArcUsdcBalance.decimals,
          formatted: formatMoney(currentArcUsdcBalance),
        },
        destinationConfiguration: {
          recipient,
          chain: ARC_TESTNET_NAME,
          chainId: ARC_TESTNET_CHAIN_ID,
          asset: "USDC",
        },
        requestedAmount: {
          amount: requestedAmount.units.toString(),
          asset: requestedAmount.asset,
          decimals: requestedAmount.decimals,
          formatted: formatMoney(requestedAmount),
        },
        sufficientBalance,
        signing: false,
        transaction: "not_submitted",
        readyForOneTestSettlement,
        blockers,
        observedAt: new Date().toISOString(),
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

"use client";

import { useAuth } from "@/lib/auth";
import { CircleSettlementCard } from "./circle-settlement-card";

export function DevSettlementView() {
  const auth = useAuth();
  return <CircleSettlementCard key={auth.ownerSubject ?? "unauthenticated"} />;
}

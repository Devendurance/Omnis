"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

export type ThinkingPhase =
  | "understanding"
  | "policy"
  | "services"
  | "wallet_check"
  | "arc_readiness"
  | "settling"
  | "confirming";

const PHASE_MESSAGES: Record<ThinkingPhase, string[]> = {
  understanding: ["understanding task", "checking policy boundaries"],
  policy: ["checking policy", "verifying service allowances"],
  services: ["finding service", "evaluating service catalog"],
  wallet_check: [
    "reserving $0.003",
    "waiting for paid service result",
    "verifying Hedera testnet receipt",
  ],
  arc_readiness: ["checking Arc readiness", "verifying wallet state"],
  settling: [
    "authorizing payment",
    "submitting to Arc",
    "confirming onchain",
  ],
  confirming: ["confirming settlement", "awaiting onchain receipt"],
};

export function ThinkingIndicator({
  phase = "services",
  customMessage,
}: {
  phase?: ThinkingPhase;
  customMessage?: string;
}) {
  const [seconds, setSeconds] = useState(0.1);
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      setSeconds(elapsed);
    }, 100);

    const messageInterval = setInterval(() => {
      setMessageIndex((prev) => prev + 1);
    }, 2400);

    return () => {
      clearInterval(interval);
      clearInterval(messageInterval);
    };
  }, [phase]);

  const messages = PHASE_MESSAGES[phase] ?? ["Omnis is working..."];
  const displayMessage =
    customMessage ?? messages[messageIndex % messages.length];

  return (
    <div
      className="omnis-thinking-panel"
      role="status"
      aria-live="polite"
      aria-label={`Omnis activity: ${displayMessage}`}
    >
      <div className="omnis-thinking-mark-wrap">
        <Image
          className="omnis-thinking-mark"
          src="/brand/useomnis-circular-mark-ink.png"
          alt=""
          aria-hidden="true"
          width={28}
          height={28}
        />
        <span className="omnis-thinking-pulse" aria-hidden="true" />
      </div>
      <div className="omnis-thinking-body">
        <span className="omnis-thinking-text">{displayMessage}</span>
        <span className="omnis-thinking-timer">{seconds.toFixed(1)}s</span>
      </div>
    </div>
  );
}

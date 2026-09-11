import type { Metadata } from "next";
import { Wallet } from "lucide-react";
import { WalletView } from "@/components/wallet-view";
export const metadata: Metadata = { title: "Wallet" };
export default function WalletPage() {
  return (
    <div className="wallet-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">the human side of financial execution</p>
          <h1>Wallet</h1>
          <p className="page-description">
            Your wallet is the starting point for approved payments. Your task
            and rules define what happens next.
          </p>
        </div>
        <span className="page-symbol" aria-hidden="true">
          <Wallet size={29} strokeWidth={1.2} />
        </span>
      </div>
      <WalletView />
    </div>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DevSettlementView } from "@/components/dev-settlement-view";

export const metadata: Metadata = {
  title: "Settlement development harness",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function SettlementDevelopmentPage() {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ENABLE_P6A_DEV_HARNESS !== "true"
  ) {
    notFound();
  }

  return (
    <div className="collection-page dev-settlement-page">
      <p className="eyebrow">development only</p>
      <h1>Settlement development harness</h1>
      <p className="page-description">
        This internal surface is not part of the public wallet experience.
      </p>
      <DevSettlementView />
    </div>
  );
}

import type { Metadata } from "next";
import { Composer } from "@/components/composer";

export const metadata: Metadata = { title: "Start a task · useOmnis" };

export default function TaskHome() {
  return (
    <div className="conversational-app-page">
      <Composer />
    </div>
  );
}

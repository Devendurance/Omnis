import type { Metadata } from "next";
import { ProductNavigation } from "@/components/navigation";
import { PreviewProvider } from "@/components/preview";
import { Wordmark } from "@/components/ui";
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default function ProductLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <PreviewProvider>
      <div className="product-shell">
        <ProductNavigation />
        <main id="main" tabIndex={-1} className="app-main">
          {children}
          <footer className="app-footer">
            <span>
              <Wordmark compact tone="ink" />{" "}
              <span aria-hidden="true">/</span> interface preview
            </span>
            <span>your task. your budget. your rules.</span>
          </footer>
        </main>
      </div>
    </PreviewProvider>
  );
}

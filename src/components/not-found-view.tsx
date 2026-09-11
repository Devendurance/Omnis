import { ArrowUpRight } from "lucide-react";
import { ActionLink } from "./ui";
export function NotFoundView({ product = false }: { product?: boolean }) {
  return (
    <div className="not-found-view">
      <p className="eyebrow">404 / route not found</p>
      <span className="not-found-symbol" aria-hidden="true">
        <ArrowUpRight size={40} strokeWidth={1} />
      </span>
      <h1>This route ends here.</h1>
      <p>
        {product
          ? "This record does not exist or is not available in this preview. No task, service, approval, or proof records have been connected."
          : "The page you’re looking for isn’t here. Return to the start and find your next step."}
      </p>
      <ActionLink href={product ? "/app" : "/"}>
        {product ? "back to the workspace" : "back to useOmnis"}
      </ActionLink>
    </div>
  );
}

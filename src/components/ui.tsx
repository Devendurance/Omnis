import Link from "next/link";
import Image from "next/image";
import {
  ArrowRight,
  Circle,
  Check,
  Clock3,
  ShieldCheck,
  ArrowUpRight,
  Ban,
  RotateCcw,
  Radio,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  checkpoints,
  type Checkpoint,
  type CheckpointState,
  type Money,
} from "@/lib/ui-model";

export type BrandTone = "light" | "ink" | "auto";

type WordmarkProps = {
  compact?: boolean;
  tone?: BrandTone;
  priority?: boolean;
};

export function Wordmark({
  compact = false,
  tone = "auto",
  priority = false,
}: WordmarkProps) {
  const marks = tone === "auto" ? ["light", "ink"] : [tone];

  return (
    <span
      className={`brand-lockup brand-lockup-${tone}${
        compact ? " brand-lockup-compact" : ""
      }`}
    >
      {marks.map((mark) => (
        <Image
          key={mark}
          className={`brand-mark brand-mark-${mark}`}
          src={`/brand/useomnis-circular-mark-${mark}.png`}
          alt=""
          aria-hidden="true"
          width={591}
          height={592}
          priority={priority}
          sizes={compact ? "28px" : "104px"}
        />
      ))}
      <span className={`wordmark${compact ? " wordmark-small" : ""}`}>
        useOmnis
        <span className="brand-dot" aria-hidden="true">
          .
        </span>
      </span>
    </span>
  );
}

export function ActionLink({
  href,
  children,
  variant = "primary",
  arrow = true,
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "outline" | "light";
  arrow?: boolean;
}) {
  return (
    <Link href={href} className={`button button-${variant}`}>
      {children}
      {arrow && <ArrowUpRight size={16} aria-hidden="true" />}
    </Link>
  );
}

const statusMap = {
  inactive: { label: "not started", icon: Circle },
  active: { label: "in progress", icon: Radio },
  complete: { label: "complete", icon: Check },
  paid: { label: "paid", icon: Check },
  waiting: { label: "waiting", icon: Clock3 },
  approval: { label: "approval needed", icon: ShieldCheck },
  settling: { label: "settling", icon: ArrowRight },
  submitted: { label: "submitted", icon: ArrowUpRight },
  blocked: { label: "blocked", icon: Ban },
  retry: { label: "retry available", icon: RotateCcw },
} as const;

export function StatusLabel({
  state,
  explanation,
}: {
  state: CheckpointState;
  explanation?: string;
}) {
  const { icon: Icon, label } = statusMap[state];
  return (
    <span className={`status status-${state}`}>
      <Icon size={14} aria-hidden="true" />
      {label}
      {explanation && <span>, {explanation}</span>}
    </span>
  );
}

export function MandateLine({
  current,
  states,
  conceptual = false,
}: {
  current?: Checkpoint;
  states?: Partial<
    Record<Checkpoint, { state: CheckpointState; explanation?: string }>
  >;
  conceptual?: boolean;
}) {
  return (
    <ol
      className={`mandate-line${conceptual ? " mandate-conceptual" : ""}`}
      aria-label={conceptual ? "How a mandate moves to proof" : "Task progress"}
    >
      {checkpoints.map((step, index) => {
        const state =
          states?.[step]?.state ?? (step === current ? "active" : "inactive");
        const Icon = conceptual ? Circle : statusMap[state].icon;
        return (
          <li
            key={step}
            data-state={state}
            aria-current={!conceptual && step === current ? "step" : undefined}
          >
            <span className="checkpoint-node">
              <Icon size={conceptual ? 8 : 14} aria-hidden="true" />
            </span>
            <span className="checkpoint-name">{step}</span>
            {!conceptual && (
              <span className="checkpoint-status">
                {statusMap[state].label}
                {states?.[step]?.explanation &&
                  `, ${states[step]?.explanation}`}
              </span>
            )}
            <span className="sr-only">
              {conceptual ? `Step ${index + 1}` : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function MoneyValue({ value }: { value: Money }) {
  return (
    <span className="money">
      {value.amount} <span>{value.asset}</span>
    </span>
  );
}

export function MetadataRows({
  rows,
}: {
  rows: ReadonlyArray<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl className="metadata-rows">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FeatureCard({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="feature-card">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2>{title}</h2>
      {children}
    </section>
  );
}

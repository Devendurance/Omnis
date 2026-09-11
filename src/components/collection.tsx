"use client";

import { useState } from "react";
import {
  Activity,
  Aperture,
  ArrowUpRight,
  FileCheck2,
  Layers3,
  MessagesSquare,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { formatMoney, type ServiceDescriptor } from "@/lib/domain";
import { filterServiceDirectory } from "@/lib/services";
import {
  pageContent,
  type CollectionKind,
  type PageState,
} from "@/lib/ui-model";
import { ActionLink } from "./ui";
import { PreviewButton } from "./preview";

const icons = {
  tasks: MessagesSquare,
  activity: Activity,
  policies: SlidersHorizontal,
  agents: Aperture,
  services: Layers3,
  approvals: ShieldCheck,
  proof: FileCheck2,
};

function servicePrice(service: ServiceDescriptor): string {
  return `${formatMoney(service.price)} ${service.price.asset}`;
}

function serviceLifecycle(service: ServiceDescriptor): string {
  if (service.catalogOnly || service.environment === "development") {
    return "development / catalog-only";
  }
  const availability =
    service.status === "available" ? "configured" : "unavailable";
  return `${service.environment} / ${availability}`;
}
function serviceSourceNote(services: readonly ServiceDescriptor[]): string {
  const live = services.find((service) => !service.catalogOnly);
  if (live?.status === "available") {
    return "live Hedera testnet service available. catalog entries are never purchased.";
  }
  if (live) {
    return "Hedera testnet service unavailable. catalog entries are never purchased.";
  }
  return "development catalog only. no service was purchased.";
}

function ServiceRecords({
  services,
  filter,
  query,
}: {
  services: readonly ServiceDescriptor[];
  filter: string;
  query: string;
}) {
  const visibleServices = filterServiceDirectory(services, {
    ...(filter === "wallet checks" ? { capabilityPrefix: "wallet-" } : {}),
    ...(filter === "research" ? { capabilityPrefix: "research" } : {}),
    query,
  });
  if (visibleServices.length === 0) {
    return (
      <div className="empty-state">
        <h2>No matching catalog entries.</h2>
        <p>Try another capability or search term.</p>
        <p className="source-note" role="status">
          {serviceSourceNote(services)}
        </p>
      </div>
    );
  }
  return (
    <div className="record-list">
      {visibleServices.map((service) => (
        <article className="record-row" key={service.id}>
          <div className="record-service">
            <strong>{service.name}</strong>
            <span>{service.description}</span>
          </div>
          <span>{service.capability}</span>
          <span className="money">{servicePrice(service)}</span>
          <div className="record-service-status">
            <span>{service.status}</span>
            <span>{serviceLifecycle(service)}</span>
            <span>
              {service.network} / {service.paymentProtocol}
            </span>
          </div>
        </article>
      ))}
      <p className="source-note record-source-note" role="status">
        {serviceSourceNote(services)}
      </p>
    </div>
  );
}

export function Collection({
  kind,
  state,
}: {
  kind: CollectionKind;
  state: PageState<readonly ServiceDescriptor[]>;
}) {
  const content = pageContent[kind];
  const [filter, setFilter] = useState<string>(content.filters[0]);
  const [query, setQuery] = useState("");
  const Icon = icons[kind];
  return (
    <div className="collection-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{content.eyebrow}</p>
          <h1>{content.title}</h1>
          <p className="page-description">{content.description}</p>
        </div>
        <span className="page-symbol" aria-hidden="true">
          <Icon size={29} strokeWidth={1.2} />
        </span>
      </div>
      <div className="collection-toolbar">
        <div className="filters" aria-label={`${content.title} filters`}>
          {content.filters.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
              className={filter === item ? "filter is-selected" : "filter"}
            >
              {item}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Search {kind}</span>
          <input
            type="search"
            placeholder={`search ${kind}...`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <section className="record-panel" aria-label={`${content.title} records`}>
        <div className="record-head" aria-hidden="true">
          {content.columns.map((column) => (
            <span key={column}>{column}</span>
          ))}
        </div>
        {kind === "services" && state.kind === "ready" ? (
          <ServiceRecords
            services={state.data}
            filter={filter}
            query={query}
          />
        ) : (
          <div className="empty-state">
            <span className="empty-orbit" aria-hidden="true">
              <Icon size={30} strokeWidth={1.1} />
            </span>
            <h2>{content.empty}</h2>
            <p>{content.help}</p>
            {content.action === "start a task" ? (
              <ActionLink href="/app">start a task</ActionLink>
            ) : (
              <PreviewButton action={content.action}>
                {content.action}
              </PreviewButton>
            )}
            <p className="source-note" role="status">
              {state.kind === "unavailable"
                ? state.reason
                : state.kind === "error"
                  ? `${state.message} ${state.moneyMovement}`
                  : state.kind === "loading"
                    ? "Loading records..."
                    : "No records available."}
              {query && " Search will apply when records are available."}
              {filter !== content.filters[0] && ` Filter selected: ${filter}.`}
            </p>
          </div>
        )}
      </section>
      <section className="collection-guide">
        <div className="guide-heading">
          <span className="eyebrow">inside omnis</span>
          <h2>{content.detailTitle}</h2>
        </div>
        <div className="guide-items">
          {content.details.map((detail) => (
            <div key={detail.label}>
              <h3>
                <ArrowUpRight size={14} aria-hidden="true" />
                {detail.label}
              </h3>
              <p>{detail.text}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Collection } from "@/components/collection";
import { pageContent, type CollectionKind } from "@/lib/ui-model";
import { getP4ALiveServiceRegistry } from "@/lib/services/server/p4a";
export const dynamic = "force-dynamic";
const collections = Object.keys(pageContent) as CollectionKind[];
export function generateStaticParams() {
  return collections.map((collection) => ({ collection }));
}
function getKind(value: string): CollectionKind {
  if (!collections.includes(value as CollectionKind)) notFound();
  return value as CollectionKind;
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ collection: string }>;
}): Promise<Metadata> {
  const kind = getKind((await params).collection);
  return { title: pageContent[kind].title };
}
export default async function CollectionPage({
  params,
}: {
  params: Promise<{ collection: string }>;
}) {
  const kind = getKind((await params).collection);
  const state =
    kind === "services"
      ? {
          kind: "ready" as const,
          data: getP4ALiveServiceRegistry().listServices({ order: "price" }),
        }
      : { kind: "unavailable" as const, reason: pageContent[kind].unavailable };
  return <Collection kind={kind} state={state} />;
}

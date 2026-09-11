import { notFound } from "next/navigation";
import ProofRecordClient from "./client";
const RECORD_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]*-[A-Za-z0-9._:-]+$/;

function isProofRecordId(id: string): boolean {
  if (RECORD_REFERENCE.test(id)) return true;
  if (!id.startsWith("omnis-proof:v1:")) return false;

  const segments = id.slice("omnis-proof:v1:".length).split(":");
  if (segments.length !== 2 || segments.some((segment) => !segment)) return false;

  try {
    return segments.every((segment) => Boolean(decodeURIComponent(segment).trim()));
  } catch {
    return false;
  }
}

export default async function ProofRecordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isProofRecordId(id)) notFound();

  return <ProofRecordClient params={Promise.resolve({ id })} />;
}

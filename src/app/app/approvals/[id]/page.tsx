import { notFound } from "next/navigation";
import ApprovalRecordClient from "./client";

const APPROVAL_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*-[A-Za-z0-9._:-]+$/;

export default async function ApprovalRecordPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!APPROVAL_RECORD_ID.test(id)) notFound();

  return <ApprovalRecordClient params={Promise.resolve({ id })} />;
}

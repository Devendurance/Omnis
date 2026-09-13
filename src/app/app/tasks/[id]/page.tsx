import { notFound } from "next/navigation";
import TaskHistoryClient from "./client";

const TASK_RECORD_ID = /^task-[A-Za-z0-9._:-]+$/;

export default async function TaskRecord({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const clean = decodeURIComponent(id);
  if (!TASK_RECORD_ID.test(clean)) notFound();

  return <TaskHistoryClient params={Promise.resolve({ id })} />;
}

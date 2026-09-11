import { notFound } from "next/navigation";
/** No source is configured. Never manufacture a record from a URL. */
export default function TaskRecord() {
  notFound();
}

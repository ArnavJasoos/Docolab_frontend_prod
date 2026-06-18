import { PlateEditor } from "@/components/editor/plate-editor";

export default async function EditorPage({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string }>;
}) {
  const { doc } = await searchParams;
  // No ?doc= → create a fresh blank document (handled in the store) instead of
  // falling back to an existing seeded doc.
  return <PlateEditor docId={doc ?? "new"} />;
}

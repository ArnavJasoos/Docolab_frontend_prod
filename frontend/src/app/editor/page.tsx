import { PlateEditor } from "@/components/editor/plate-editor";

export default async function EditorPage({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string }>;
}) {
  const { doc } = await searchParams;
  return <PlateEditor docId={doc ?? "project-nexus"} />;
}

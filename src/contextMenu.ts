export function installContextMenuGuard(documentRoot: Document = document): () => void {
  const preventNonEditableContextMenu = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true']")) return;
    event.preventDefault();
  };

  documentRoot.addEventListener("contextmenu", preventNonEditableContextMenu);
  return () => {
    documentRoot.removeEventListener("contextmenu", preventNonEditableContextMenu);
  };
}

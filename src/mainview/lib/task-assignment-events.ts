/** Fired after an Owner changes a task ↔ worker link so batch prep can refresh. */
export function publishTaskAssignmentChanged(taskId: string): void {
  window.dispatchEvent(new CustomEvent("task-assignment-changed", { detail: { taskId } }));
}

export function subscribeTaskAssignmentChanged(listener: (taskId: string) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ taskId?: string }>).detail;
    if (typeof detail?.taskId === "string") listener(detail.taskId);
  };
  window.addEventListener("task-assignment-changed", handler);
  return () => window.removeEventListener("task-assignment-changed", handler);
}

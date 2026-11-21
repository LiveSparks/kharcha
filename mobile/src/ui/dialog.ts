// Messages and confirmations, drawn in the app's own style by <DialogHost /> (mounted once
// in the root layout) instead of the system alert. Requests queue: one shows at a time.

export interface DialogRequest {
  id: number;
  title: string;
  message: string;
  // Present for a confirmation: the action's label, and what it does.
  confirm?: { action: string; onConfirm: () => void };
}

type Listener = (queue: readonly DialogRequest[]) => void;

let queue: DialogRequest[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function publish(): void { for (const listener of listeners) listener(queue); }

export function subscribeDialogs(listener: Listener): () => void {
  listeners.add(listener);
  listener(queue);
  return () => { listeners.delete(listener); };
}

// Closes the dialog on screen; `confirmed` runs a confirmation's action after it closes.
export function closeDialog(id: number, confirmed: boolean): void {
  const request = queue.find(r => r.id === id);
  if (!request) return;
  queue = queue.filter(r => r.id !== id);
  publish();
  if (confirmed) request.confirm?.onConfirm();
}

export function showMessage(title: string, message: string): void {
  queue = [...queue, { id: nextId++, title, message }];
  publish();
}

export function confirmAction(title: string, message: string, action: string, onConfirm: () => void): void {
  queue = [...queue, { id: nextId++, title, message, confirm: { action, onConfirm } }];
  publish();
}

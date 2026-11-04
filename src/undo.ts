// ---------------------------------------------------------------------------
// UndoStack — a simple inverse-action stack for STRUCTURAL changes (add/delete/
// move/assign cards & loci, connections). Each action pushes a closure that
// reverses it. Text edits are intentionally not tracked (the browser already
// undoes typing inside a field).
// ---------------------------------------------------------------------------
export type UndoFn = () => void;

export class UndoStack {
  private stack: { label: string; undo: UndoFn }[] = [];
  private onChange?: () => void;

  constructor(onChange?: () => void) {
    this.onChange = onChange;
  }

  /** Record a reversible action. `undo` should restore the prior state. */
  push(label: string, undo: UndoFn) {
    this.stack.push({ label, undo });
    this.onChange?.();
  }

  /** Reverse the most recent action, if any. */
  undo() {
    const e = this.stack.pop();
    if (e) e.undo();
    this.onChange?.();
  }

  get canUndo() {
    return this.stack.length > 0;
  }
}

/** Native file approval requests reference an item instead of repeating its
 * changes. Keep bounded, scoped proposals until the item or turn ends.
 * Evidence: codex rust-v0.166.0 app-server-protocol/src/protocol/v2/item.rs,
 * FileChangeRequestApprovalParams and FileChangePatchUpdatedNotification. */
import { fileChangePaths } from "./codex-session-approvals.js";

export const MAX_PATCH_APPROVAL_ITEMS = 128;
export const MAX_PATCH_APPROVAL_BYTES = 1024 * 1024;

export class CodexPatchApprovals {
  private readonly items = new Map<string, { changes: unknown[]; bytes: number; turn: string }>();
  private bytes = 0;

  record(thread: string, turn: string, item: string, changes: unknown): void {
    const key = JSON.stringify([thread, turn, item]);
    this.remove(key);
    if (!Array.isArray(changes) || fileChangePaths({ changes }).length === 0) return;
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(changes));
    if (bytes > MAX_PATCH_APPROVAL_BYTES) return;
    while (this.items.size >= MAX_PATCH_APPROVAL_ITEMS || this.bytes + bytes > MAX_PATCH_APPROVAL_BYTES) {
      this.remove(this.items.keys().next().value!);
    }
    this.items.set(key, { changes, bytes, turn });
    this.bytes += bytes;
  }

  changes(thread: string, turn: string, item: unknown): unknown[] | undefined {
    if (typeof item !== "string") return undefined;
    return this.items.get(JSON.stringify([thread, turn, item]))?.changes;
  }

  forgetItem(thread: string, turn: string, item: string): void {
    this.remove(JSON.stringify([thread, turn, item]));
  }

  forgetTurn(turn: string): void {
    for (const [key, entry] of this.items) {
      if (entry.turn === turn) this.remove(key);
    }
  }

  private remove(key: string): void {
    const entry = this.items.get(key);
    if (entry === undefined) return;
    this.bytes -= entry.bytes;
    this.items.delete(key);
  }
}

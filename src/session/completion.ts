import { isEmptyAnswer } from "../result-empty.js";
import { BoundedOutboundQueue } from "./process-outbound.js";

type TurnFinish = "end" | "failed" | "interrupted";

/** Session events and ledger records share this completion verdict. Only
 * assistant text answers a turn; tool output and reasoning do not. */
export class SessionOutputQueue extends BoundedOutboundQueue {
  private turnId: string | null = null;
  private answered = false;
  private open = false;
  private completed: { turnId: string | null; answered: boolean } | null = null;

  completeTurn(
    turnId: string | null,
    finish: TurnFinish,
    reason?: string | null
  ): { finish: TurnFinish; reason?: string } {
    const answered = turnId === this.turnId ? this.answered
      : turnId === this.completed?.turnId ? this.completed.answered : true;
    if (turnId !== null && !answered && finish === "end") {
      return { finish: "failed", reason: "empty answer" };
    }
    return { finish, ...(reason == null ? {} : { reason }) };
  }

  override enqueue(line: string, options?: { terminal?: boolean | "fatal" }): boolean {
    const event = JSON.parse(line) as Record<string, unknown>;
    const turnId = typeof event.turn_id === "string" ? event.turn_id : null;
    if (event.type === "turn_started") {
      this.turnId = turnId;
      this.answered = false;
      this.open = true;
    } else if (this.open && turnId === this.turnId &&
        (event.type === "assistant_message" || event.type === "assistant_delta")) {
      const text = event.type === "assistant_delta" ? event.delta : event.text;
      if (typeof text === "string" && !isEmptyAnswer(text)) this.answered = true;
    } else if (event.type === "turn_completed") {
      const finish = event.finish;
      if (finish === "end" || finish === "failed" || finish === "interrupted") {
        Object.assign(event, this.completeTurn(turnId, finish,
          typeof event.reason === "string" ? event.reason : undefined));
        line = JSON.stringify(event);
      }
      if (turnId === this.turnId) {
        this.completed = { turnId, answered: this.answered };
        this.open = false;
      }
    }
    return super.enqueue(line, options);
  }
}

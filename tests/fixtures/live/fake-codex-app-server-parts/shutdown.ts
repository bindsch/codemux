import { notify, record, respond, respondError, THREAD_ID } from "./wire.js";

let acknowledged = false;

/** Model the 0.167 cleanup ordering: EOF before unsubscribe's reply fails. */
export function handleUnsubscribe(id: unknown): void {
  const mode = process.env.FAKE_UNSUBSCRIBE;
  if (mode === "missing") return;
  if (mode === "reject") {
    respondError(id, "unsubscribe refused");
    return;
  }
  setTimeout(() => {
    acknowledged = true;
    const status = mode === "invalid" ? "unexpected" : mode === "notLoaded" || mode === "notSubscribed" ? mode : "unsubscribed";
    record("shutdown.jsonl", { event: "unsubscribe_answer", status });
    respond(id, { status });
    if (mode === "closed") notify("thread/closed", { threadId: THREAD_ID });
  }, 30);
}

export function checkUnsubscribeAtEof(): void {
  record("shutdown.jsonl", { event: "eof", acknowledged });
  if (process.env.FAKE_UNSUBSCRIBE && !acknowledged) process.exit(1);
  if (process.env.FAKE_UNSUBSCRIBE_EXIT) process.exit(Number(process.env.FAKE_UNSUBSCRIBE_EXIT));
}

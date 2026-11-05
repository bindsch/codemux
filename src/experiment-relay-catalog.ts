import type { ServerResponse } from "node:http";
import type { ExperimentRecord } from "./experiment-records.js";

/** A connection as this tracker needs it: an identity and two events. */
interface Connection {
  once(event: "error" | "close", listener: () => void): unknown;
  off(event: "error" | "close", listener: () => void): unknown;
}

/**
 * Whether Codex has the served model catalog (review rounds 115 and 116).
 *
 * An HTTP server cannot see the client read a response. What it can see
 * is the connection, and the rule here uses all of it:
 *
 * - `finish` on the response: the whole catalog was handed to the socket.
 *   Only then is `catalog_served` recorded and the fetch counted. A
 *   response that closes without finishing counts for nothing.
 * - An error on that connection afterwards, before the client used it
 *   again: a client that closes with the body unread resets the
 *   connection, and the reset arrives here as the socket's error. The
 *   fetch is then uncounted and `catalog_fetch_reset` is recorded.
 * - A request that arrives on the same connection after the response
 *   finished, or the connection's orderly close, settles the fetch: a
 *   client reads a response before it sends the next request on a
 *   connection, so a reset after that belongs to later traffic and
 *   uncounts nothing. A request that arrives before the response finished
 *   was pipelined behind it and settles nothing, and a catalog response
 *   that has no connection of its own to watch (one queued behind another
 *   on a pipelined connection) is never counted (review round 117).
 *
 * The limit, which is deliberate: HTTP gives a server no receipt. A
 * client that lets the response finish and then, without reading it,
 * sends another request or closes in order shows the server exactly what
 * a client that read it shows (measured: the same `end` and `close`, no
 * error). A stricter rule has no evidence to use. Counting only fetches
 * that a later request confirms would fail every client that fetches the
 * catalog on a connection of its own and then closes it, which is an
 * ordinary client, so the run would fail for a catalog that was read.
 * The rule therefore catches the abandoned transfer a server can see,
 * the reset, and docs/experiment-codex-catalog.md states the rest.
 *
 * The gate reads the count when the first function call arrives. A
 * reset that arrives after that moment cannot undo the call; the fetch
 * is uncounted from then on, and `catalog_fetch_reset` is in the record.
 *
 * The cost, also deliberate: a reset looks the same whether the body was
 * read or not, so a client that read the catalog and then closes the
 * connection abortively, before using it again, loses the fetch too
 * (review round 119). The gate fails closed there. An HTTP client ends a
 * connection it read from in order, and one that does not can fetch the
 * catalog again: a later complete fetch counts.
 *
 * Recording can throw (a full disk, the recording size limit). These
 * callbacks run outside the request handler's error boundary, so each
 * routes a throw to the relay's own failure path, never to an uncaught
 * exception.
 */
export class CatalogDelivery {
  private counted = 0;
  /** Per connection: its open fetches, each with the way to settle it and
   * whether its response has finished. More than one is open only when
   * catalog requests were pipelined. */
  private readonly unsettled = new Map<Connection, Set<{ settle: () => void; finished: () => boolean }>>();

  constructor(
    private readonly record: ExperimentRecord,
    private readonly fail: (error: unknown) => void,
    /** False once the relay closed or failed: nothing is recorded then. */
    private readonly active: () => boolean
  ) {}

  /** True while at least one complete, unrevoked fetch stands. */
  get served(): boolean {
    return this.counted > 0;
  }

  /** A request arrived on this connection. When the catalog response
   * before it had finished, the client read it; when it had not, the
   * request was pipelined and proves nothing. */
  requestArrived(connection: Connection | null | undefined): void {
    const open = connection ? this.unsettled.get(connection) : undefined;
    for (const fetch of [...(open ?? [])]) if (fetch.finished()) fetch.settle();
  }

  /** Watch one catalog response. Call before the response is ended: a
   * small body can finish inside `end`. */
  track(response: ServerResponse, clientVersion: string | null, bytes: number): void {
    const connection = (response.socket ?? null) as Connection | null;
    let counted = false;
    let reset = false;
    let finished = false;
    const open = { settle: (): void => settle(), finished: (): boolean => finished };
    const settle = (): void => {
      if (connection === null) return;
      connection.off("error", onError);
      connection.off("close", settle);
      const fetches = this.unsettled.get(connection);
      fetches?.delete(open);
      if (fetches?.size === 0) this.unsettled.delete(connection);
    };
    const onError = (): void => {
      reset = true;
      settle();
      if (!counted) return;
      counted = false;
      this.counted--;
      this.guarded(() => this.record("catalog_fetch_reset", { client_version: clientVersion, bytes }));
    };
    if (connection !== null) {
      connection.once("error", onError);
      connection.once("close", settle);
      const fetches = this.unsettled.get(connection) ?? new Set();
      fetches.add(open);
      this.unsettled.set(connection, fetches);
    }
    response.once("finish", () => {
      finished = true;
      // No connection to watch: the response was queued behind another on
      // a pipelined connection, and nothing would show its reset. It
      // counts for nothing rather than for a fetch that cannot be checked.
      if (reset || connection === null) return;
      this.guarded(() => {
        this.record("catalog_served", { client_version: clientVersion, bytes });
        counted = true;
        this.counted++;
      });
    });
  }

  private guarded(act: () => void): void {
    if (!this.active()) return;
    try {
      act();
    } catch (error) {
      this.fail(error);
    }
  }
}

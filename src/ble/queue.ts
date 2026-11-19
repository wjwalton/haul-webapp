/**
 * One serial queue for EVERY GATT operation on a link: writes, reads, notification start/stop
 * (docs/SPEC.md "Web Bluetooth specifics"). One operation is in flight at a time, in FIFO order.
 *
 * - cancelPending() drops operations that haven't been issued yet (their callers get
 *   OpCancelledError). An issued operation can't be recalled: it runs to completion.
 * - A per-operation timeout rejects the CALLER with GattTimeoutError, but the queue still waits for
 *   that operation to settle before issuing the next one: two GATT operations never overlap (Chrome
 *   fails concurrent ones with "GATT operation already in progress").
 * - close() (on disconnect) rejects everything pending and refuses new work.
 */

export class OpCancelledError extends Error {
  constructor(label: string, reason: string) {
    super(`${label}: cancelled before it was sent (${reason})`);
    this.name = 'OpCancelledError';
  }
}

export class GattTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: no completion within ${ms} ms`);
    this.name = 'GattTimeoutError';
  }
}

export class QueueClosedError extends Error {
  constructor(reason: string) {
    super(`Bluetooth queue closed: ${reason}`);
    this.name = 'QueueClosedError';
  }
}

export interface QueueOpInfo {
  label: string;
  tag: string | undefined;
  /** ms the op waited in the queue */
  waitedMs: number;
  /** ms from issue to completion (or failure) */
  ranMs: number;
  ok: boolean;
  timedOut: boolean;
}

interface Entry {
  label: string;
  tag: string | undefined;
  op: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timeoutMs: number;
  enqueuedAt: number;
}

export interface QueueOptions {
  /** Default per-op timeout (Android GATT_OP_MS = 10 s). 0 = none. */
  opTimeoutMs?: number;
  now?: () => number;
  /** Every completed op, with timings (the controller update logs per-block write times from this). */
  onOp?: (info: QueueOpInfo) => void;
}

export class GattQueue {
  private readonly q: Entry[] = [];
  private running: Entry | null = null;
  private pumping = false;
  private closedReason: string | null = null;
  private idleWaiters: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: QueueOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Queue [op]; it starts after everything queued before it has completed. */
  run<T>(label: string, op: () => Promise<T>, o: { tag?: string; timeoutMs?: number } = {}): Promise<T> {
    if (this.closedReason !== null) return Promise.reject(new QueueClosedError(this.closedReason));
    return new Promise<T>((resolve, reject) => {
      this.q.push({
        label, tag: o.tag, op, resolve: resolve as (v: unknown) => void, reject,
        timeoutMs: o.timeoutMs ?? this.opts.opTimeoutMs ?? 10_000, enqueuedAt: this.now(),
      });
      void this.pump();
    });
  }

  /** Drop not-yet-issued ops (all, or those matching [filter]). Returns how many were dropped. */
  cancelPending(filter: (label: string, tag: string | undefined) => boolean = () => true, reason = 'cancelled'): number {
    let n = 0;
    for (let i = this.q.length - 1; i >= 0; i--) {
      const e = this.q[i]!;
      if (filter(e.label, e.tag)) {
        this.q.splice(i, 1);
        e.reject(new OpCancelledError(e.label, reason));
        n++;
      }
    }
    if (n) this.checkIdle();
    return n;
  }

  /** Reject everything pending and refuse new ops (the link is gone). The op in flight can't be recalled. */
  close(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    const dropped = this.q.splice(0);
    for (const e of dropped) e.reject(new QueueClosedError(reason));
    this.checkIdle();
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  get pendingCount(): number {
    return this.q.length;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** Resolves once nothing is queued or running. */
  idle(): Promise<void> {
    if (!this.running && this.q.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.q.length) {
        const e = this.q.shift()!;
        this.running = e;
        await this.execute(e);
        this.running = null;
      }
    } finally {
      this.pumping = false;
      this.checkIdle();
    }
  }

  private async execute(e: Entry): Promise<void> {
    const started = this.now();
    let settled = false;
    let timedOut = false;
    let ok = false;
    const timer = e.timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = timedOut = true;
          e.reject(new GattTimeoutError(e.label, e.timeoutMs));
        }, e.timeoutMs)
      : undefined;
    try {
      const v = await e.op();
      ok = true;
      if (!settled) {
        settled = true;
        e.resolve(v);
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        e.reject(err);
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.opts.onOp?.({
        label: e.label, tag: e.tag, waitedMs: started - e.enqueuedAt, ranMs: this.now() - started, ok: ok && !timedOut, timedOut,
      });
    }
  }

  private checkIdle(): void {
    if (this.running || this.q.length || this.pumping) return;
    const w = this.idleWaiters.splice(0);
    for (const r of w) r();
  }
}

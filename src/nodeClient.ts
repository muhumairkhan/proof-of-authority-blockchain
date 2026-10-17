import WebSocket from "ws";
import { Transaction } from "./types";
import { Wallet } from "./wallet";

export interface AccountInfo {
  address: string;
  balance: number;
  nonce: number;
  nextNonce: number;
}

export class NodeClientError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown,
  ) {
    super(message);
    this.name = "NodeClientError";
  }
}

/** Accepts ws://, wss://, and (for old NODE_URL values) http://, https://. */
export function toWsUrl(url: string): string {
  return url.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
}

/**
 * Minimal client for a node's WebSocket API. Each call opens a connection,
 * makes one request, and closes — plenty for the CLI, tests and scripts.
 * (Subscriptions are for long-lived UIs and are not exposed here.)
 */
export class NodeClient {
  readonly url: string;

  constructor(
    url: string = process.env.NODE_URL || "ws://localhost:3000",
    private readonly timeoutMs = 10_000,
  ) {
    this.url = toWsUrl(url);
  }

  request<T = any>(method: string, params: object = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const REQUEST_ID = 1;
      let settled = false;
      const ws = new WebSocket(this.url);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.on("error", () => {}); // swallow late errors so they can't crash the process
        ws.terminate();
        fn();
      };

      const timer = setTimeout(
        () =>
          finish(() =>
            reject(new NodeClientError(`request to ${this.url} timed out`)),
          ),
        this.timeoutMs,
      );

      ws.on("open", () =>
        ws.send(JSON.stringify({ id: REQUEST_ID, method, params })),
      );

      ws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg?.id !== REQUEST_ID) return; // ignore pushes / unrelated messages
        if (msg.error) {
          finish(() =>
            reject(
              new NodeClientError(
                msg.error.message,
                msg.error.code,
                msg.error.data,
              ),
            ),
          );
        } else {
          finish(() => resolve(msg.result as T));
        }
      });

      ws.on("error", (err) =>
        finish(() =>
          reject(
            new NodeClientError(`cannot reach ${this.url}: ${err.message}`),
          ),
        ),
      );
      ws.on("close", () =>
        finish(() =>
          reject(
            new NodeClientError("connection closed before a response arrived"),
          ),
        ),
      );
    });
  }

  getStatus() {
    return this.request("getStatus");
  }

  getAccount(address: string): Promise<AccountInfo> {
    return this.request<AccountInfo>("getAccount", { address });
  }

  submitTransaction(transaction: Transaction) {
    return this.request<{ success: boolean; transaction: Transaction }>(
      "submitTransaction",
      { transaction },
    );
  }

  /**
   * Fetches the sender's next usable nonce (confirmed + pending), signs, submits.
   * Returns the accepted transaction. `wallet` must be unlocked.
   */
  async send(wallet: Wallet, to: string, amount: number): Promise<Transaction> {
    const account = await this.getAccount(wallet.address);
    const tx = wallet.createTransaction(to, amount, account.nextNonce);
    await this.submitTransaction(tx);
    return tx;
  }
}

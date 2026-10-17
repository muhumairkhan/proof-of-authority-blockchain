import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { Wallet } from "./wallet";

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * Keystore files in a directory (default ./wallets), one `<name>.json` each.
 * The only place that touches the filesystem for wallets. Loaded wallets are
 * LOCKED; call wallet.unlock(passphrase) to sign.
 */
export class WalletStore {
  constructor(private readonly dir = "wallets") {}

  /** Names become filenames, so only allow a safe character set (no ../ tricks). */
  private assertName(name: string) {
    if (!NAME_RE.test(name)) {
      throw new Error(
        `invalid wallet name "${name}" (use letters, digits, "-" and "_")`,
      );
    }
  }

  path(name: string): string {
    this.assertName(name);
    return `${this.dir}/${name}.json`;
  }

  exists(name: string): boolean {
    return existsSync(this.path(name));
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .filter((n) => NAME_RE.test(n))
      .sort();
  }

  load(name: string): Wallet {
    const path = this.path(name);
    if (!existsSync(path)) throw new Error(`No wallet found at ${path}`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      throw new Error(`${path} is not valid JSON`);
    }
    return Wallet.fromKeystore(raw);
  }

  /** Saves under `name` (also written into the keystore). Refuses to overwrite unless asked. */
  save(
    name: string,
    wallet: Wallet,
    opts: { overwrite?: boolean } = {},
  ): string {
    const path = this.path(name);
    if (existsSync(path) && !opts.overwrite) {
      throw new Error(`Wallet "${name}" already exists at ${path}`);
    }
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const tmp = `${path}.tmp`; // temp + rename: a crash never leaves a half-written keystore
    writeFileSync(tmp, JSON.stringify(wallet.exportKeystore(name), null, 2));
    renameSync(tmp, path);
    return path;
  }

  delete(name: string): boolean {
    const path = this.path(name);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  /** Accepts a raw 0x address or the name of a stored wallet. */
  resolveAddress(nameOrAddress: string): string {
    if (nameOrAddress.startsWith("0x")) {
      const addr = nameOrAddress.toLowerCase();
      if (!ADDRESS_RE.test(addr))
        throw new Error("address must be 0x followed by 40 hex characters");
      return addr;
    }
    return this.load(nameOrAddress).address;
  }
}

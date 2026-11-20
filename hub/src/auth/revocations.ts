// Account deletion revokes what was issued before it (execution WBS 5.4).
//
// Access tokens and sessions are signed and checked without a store read, so on their own they would outlive the account
// they name: an agent holding a token for up to an hour, or another device's session for up to eight, could write into an
// account that was just deleted and bring it back. Deletion therefore writes a tombstone first (Spaces.deleteAccount →
// Store.markDeleted), and every bearer check and every session check asks here whether the credential was issued before
// it. A later sign-in with the same identity is issued after the tombstone and opens a fresh, empty account.
//
// Each instance remembers an answer for CACHE_MS, so a deletion reaches the other Cloud Run instances within that time;
// the instance that deleted the account is told at once (note).
import type { Store } from '../store/types.js';

const CACHE_MS = 30_000;
const CACHE_MAX = 5_000;   // accounts remembered per instance; past it the memory starts over

export class Revocations {
  private seen = new Map<string, { at: number | null; until: number }>();
  constructor(private store: Store, private now: () => number = Date.now) {}

  /** True when the account was deleted after this credential was issued (`iat` in seconds, as a JWT carries it). */
  async revoked(uid: string, iat: number): Promise<boolean> {
    const t = this.now(), hit = this.seen.get(uid);
    let at: number | null;
    if (hit && hit.until > t) at = hit.at;
    else {
      at = await this.store.deletedAt(uid);
      if (this.seen.size >= CACHE_MAX) this.seen.clear();
      this.seen.set(uid, { at, until: t + CACHE_MS });
    }
    return at !== null && !(iat * 1000 >= at);   // a missing or malformed iat counts as issued before
  }

  /** The instance that deleted the account refuses its old credentials from the next request on. */
  note(uid: string, at: number) { this.seen.set(uid, { at, until: this.now() + CACHE_MS }); }
}

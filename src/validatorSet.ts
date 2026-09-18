export class ValidatorSet {
  private validators: string[]; // public keys (PEM), in rotation order

  constructor(validators: string[]) {
    if (validators.length === 0) {
      throw new Error('ValidatorSet needs at least one validator');
    }
    this.validators = validators;
  }

  /**
   * Which validator owns a given time slot. Slots are fixed-width buckets
   * of wall-clock time measured from a shared, fixed origin (time 0 —
   * equivalent to genesis's own fixed timestamp of 0), so every node
   * computes the exact same owner for the exact same slot number without
   * needing to agree on chain height or on which peers are "up".
   * Ownership cycles through the validator set indefinitely: if a slot's
   * owner doesn't propose in time, the NEXT slot (a fixed time later)
   * automatically belongs to a different validator — no timeout detection
   * or liveness-checking needed anywhere.
   */
  getValidatorForSlot(slot: number): string {
    return this.validators[this.getIndexForSlot(slot)];
  }

  /** Index (into the rotation order) of the validator who owns a slot. */
  getIndexForSlot(slot: number): number {
    const n = this.validators.length;
    return ((slot % n) + n) % n; // defensive mod for any negative slot
  }

  isKnownValidator(publicKey: string): boolean {
    return this.validators.includes(publicKey);
  }

  getAll(): string[] {
    return [...this.validators];
  }
}

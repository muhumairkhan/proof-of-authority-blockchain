export class ValidatorSet {
  private validators: string[]; // public keys (PEM), in rotation order

  constructor(validators: string[]) {
    if (validators.length === 0) {
      throw new Error('ValidatorSet needs at least one validator');
    }
    this.validators = validators;
  }

  /** Simple round-robin: block index N is always signed by the same validator. */
  getValidatorForIndex(blockIndex: number): string {
    return this.validators[(blockIndex - 1) % this.validators.length];
  }

  isKnownValidator(publicKey: string): boolean {
    return this.validators.includes(publicKey);
  }

  getAll(): string[] {
    return [...this.validators];
  }
}

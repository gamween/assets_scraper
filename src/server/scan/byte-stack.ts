/** A stack of numbers below 256, one byte each: CSS can nest as deep as it is long. */
export class ByteStack {
  private bytes = new Uint8Array(64);
  length = 0;

  push(value: number) {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length++] = value;
  }

  pop() {
    this.length -= 1;
  }

  /** The value on top, or -1 when the stack is empty. */
  top(): number {
    return this.length ? this.bytes[this.length - 1] : -1;
  }
}

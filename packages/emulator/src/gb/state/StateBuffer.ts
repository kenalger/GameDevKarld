/** "WBST" — WebBoy STate. */
export const STATE_MAGIC = 0x57425354;

/**
 * The GBA container carries its own magic.
 *
 * Both systems share this buffer format, but their section layouts have nothing in common,
 * so a distinct magic turns "wrong console" into a clean refusal instead of a misparse.
 */
export const STATE_MAGIC_GBA = 0x57424741;

/**
 * A 32-bit identity for the loaded cartridge.
 *
 * States are refused when this does not match, so a state from another game cannot be
 * resumed into the wrong ROM.
 */
export function cartridgeFingerprint(info: { saveKey: string } | null): number {
  if (!info) return 0;
  let hash = 0x811c9dc5;
  for (const ch of info.saveKey) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return hash;
}

/**
 * Format version.
 *
 * BUMP THIS whenever any subsystem's layout changes. A state that silently misparses is
 * far worse than one that refuses to load: the game appears to work and then corrupts.
 */
export const STATE_VERSION = 6;

/**
 * Reads just the container header, without parsing the state.
 *
 * A list of save states has to be able to say "this one is from an older format" rather
 * than showing it as loadable and failing only when the player clicks Load. Deserializing
 * each slot to find that out would mean parsing every state to draw a list.
 *
 * Returns null if the data is too short or is not a WebBoy state at all.
 */
export function readStateHeader(data: Uint8Array): { magic: number; version: number } | null {
  if (data.byteLength < 6) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== STATE_MAGIC && magic !== STATE_MAGIC_GBA) return null;
  return { magic, version: view.getUint16(4, true) };
}

export class StateFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateFormatError';
  }
}

/**
 * Sequential binary writer.
 *
 * Grows geometrically so serialization never depends on knowing the size up front, and
 * every subsystem writes into one contiguous buffer rather than allocating its own.
 */
export class StateWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;

  constructor(initialCapacity = 64 * 1024) {
    this.buffer = new ArrayBuffer(initialCapacity);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  private ensure(extra: number): void {
    if (this.offset + extra <= this.buffer.byteLength) return;
    let capacity = this.buffer.byteLength;
    while (capacity < this.offset + extra) capacity *= 2;
    const next = new ArrayBuffer(capacity);
    new Uint8Array(next).set(this.bytes.subarray(0, this.offset));
    this.buffer = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.offset, value & 0xff);
    this.offset += 1;
  }

  u16(value: number): void {
    this.ensure(2);
    this.view.setUint16(this.offset, value & 0xffff, true);
    this.offset += 2;
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  /** Doubles are used for values that legitimately exceed 32 bits, like cycle counters. */
  f64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  bytesOf(data: Uint8Array): void {
    this.u32(data.length);
    this.ensure(data.length);
    this.bytes.set(data, this.offset);
    this.offset += data.length;
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.offset);
  }

  get length(): number {
    return this.offset;
  }
}

/** Sequential binary reader. Every read is bounds-checked, so truncation fails loudly. */
export class StateReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private check(size: number): void {
    if (this.offset + size > this.bytes.length) {
      throw new StateFormatError(
        `Save state is truncated: needed ${size} bytes at offset ${this.offset}, but only ${this.bytes.length} bytes exist.`,
      );
    }
  }

  u8(): number {
    this.check(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    this.check(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.check(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.check(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  bytesOf(): Uint8Array {
    const length = this.u32();
    this.check(length);
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  /** Reads into an existing array, which must be the size that was written. */
  intoArray(target: Uint8Array): void {
    const data = this.bytesOf();
    if (data.length !== target.length) {
      throw new StateFormatError(
        `Save state section size mismatch: expected ${target.length} bytes, found ${data.length}.`,
      );
    }
    target.set(data);
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }
}

/**
 * Shared channel building blocks.
 *
 * Kept separate because the length counter's "extra clocking" quirk and the envelope's
 * reload rules are identical across channels, and getting them subtly different per channel
 * is how Blargg's `03-trigger` and `04-sweep` start failing in confusing ways.
 */

/** Length counter. Silences a channel after a set duration when enabled. */
export class LengthCounter {
  value = 0;
  enabled = false;

  constructor(private readonly max: number) {}

  reset(): void {
    this.value = 0;
    this.enabled = false;
  }

  /** Writing NRx1 loads the counter with `max - n`. */
  load(n: number): void {
    this.value = this.max - n;
  }

  /** Returns true when the channel should be disabled. */
  clock(): boolean {
    if (!this.enabled || this.value === 0) return false;
    this.value--;
    return this.value === 0;
  }

  /**
   * NRx4 write. Returns true when the channel should be disabled as a result.
   *
   * THE EXTRA-CLOCKING QUIRK: enabling length during a frame-sequencer step that does NOT
   * itself clock length causes one immediate extra decrement. Blargg tests it directly, and
   * games rely on it for short blips.
   */
  writeControl(enable: boolean, trigger: boolean, nextStepClocksLength: boolean): boolean {
    const wasEnabled = this.enabled;
    this.enabled = enable;

    let disable = false;
    if (!wasEnabled && enable && !nextStepClocksLength && this.value > 0) {
      this.value--;
      if (this.value === 0 && !trigger) disable = true;
    }

    if (trigger && this.value === 0) {
      this.value = this.max;
      // Triggering into an enabled counter on a non-clocking step also loses one tick.
      if (this.enabled && !nextStepClocksLength) this.value--;
    }
    return disable;
  }
}

/** Volume envelope. Steps the channel volume up or down at 64Hz. */
export class VolumeEnvelope {
  volume = 0;
  private initialVolume = 0;
  private addMode = false;
  private period = 0;
  private timer = 0;
  private finished = true;

  reset(): void {
    this.volume = 0;
    this.initialVolume = 0;
    this.addMode = false;
    this.period = 0;
    this.timer = 0;
    this.finished = true;
  }

  /** NRx2. Returns the raw register value for read-back. */
  write(value: number): void {
    this.initialVolume = (value >> 4) & 0x0f;
    this.addMode = (value & 0x08) !== 0;
    this.period = value & 0x07;
  }

  read(): number {
    return (this.initialVolume << 4) | (this.addMode ? 0x08 : 0) | this.period;
  }

  /** The DAC is powered only while the upper 5 bits of NRx2 are non-zero. */
  get dacEnabled(): boolean {
    return this.initialVolume !== 0 || this.addMode;
  }

  trigger(): void {
    this.volume = this.initialVolume;
    this.timer = this.period === 0 ? 8 : this.period;
    this.finished = false;
  }

  clock(): void {
    if (this.period === 0 || this.finished) return;
    if (--this.timer > 0) return;

    this.timer = this.period;
    const next = this.volume + (this.addMode ? 1 : -1);
    if (next < 0 || next > 15) {
      this.finished = true;
      return;
    }
    this.volume = next;
  }
}

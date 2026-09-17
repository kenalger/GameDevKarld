/** MBC3's real-time clock, as the five latchable registers plus a base timestamp. */
export interface RtcState {
  seconds: number;
  minutes: number;
  hours: number;
  /** 9-bit day counter, split across DL and DH bit 0. */
  days: number;
  halted: boolean;
  /** Set when the day counter overflows past 511, and sticky until cleared by software. */
  dayCarry: number;
  /**
   * Wall-clock milliseconds when the clock was last brought up to date.
   *
   * Persisting this is what makes the RTC survive the tab being closed: on load the clock
   * is advanced by however much real time elapsed. Without it, closing the game would stop
   * the in-game clock, and games with day/night cycles or berry growth would never advance.
   */
  baseTimeMs: number;
}

const SECONDS_PER_DAY = 86400;
export const MAX_DAYS = 512;

export function createRtcState(nowMs: number = Date.now()): RtcState {
  return {
    seconds: 0,
    minutes: 0,
    hours: 0,
    days: 0,
    halted: false,
    dayCarry: 0,
    baseTimeMs: nowMs,
  };
}

/** Advances the clock by the real time elapsed since `baseTimeMs`. */
export function advanceRtc(state: RtcState, nowMs: number = Date.now()): void {
  if (state.halted) {
    state.baseTimeMs = nowMs;
    return;
  }

  const elapsedSeconds = Math.floor((nowMs - state.baseTimeMs) / 1000);
  if (elapsedSeconds <= 0) return;

  state.baseTimeMs += elapsedSeconds * 1000;

  let total =
    state.seconds +
    state.minutes * 60 +
    state.hours * 3600 +
    state.days * SECONDS_PER_DAY +
    elapsedSeconds;

  const days = Math.floor(total / SECONDS_PER_DAY);
  total -= days * SECONDS_PER_DAY;

  state.hours = Math.floor(total / 3600);
  total -= state.hours * 3600;
  state.minutes = Math.floor(total / 60);
  state.seconds = total - state.minutes * 60;

  if (days >= MAX_DAYS) {
    state.dayCarry = 1;
    state.days = days % MAX_DAYS;
  } else {
    state.days = days;
  }
}

/** Serialises the RTC into the 48-byte tail other emulators append to a `.sav`. */
export function serializeRtc(state: RtcState): Uint8Array {
  const out = new Uint8Array(48);
  const view = new DataView(out.buffer);
  const fields = [
    state.seconds,
    state.minutes,
    state.hours,
    state.days & 0xff,
    ((state.days >> 8) & 0x01) | (state.halted ? 0x40 : 0) | (state.dayCarry ? 0x80 : 0),
  ];
  // Five little-endian 32-bit latched values, then five live ones, then the timestamp.
  fields.forEach((value, i) => {
    view.setUint32(i * 4, value, true);
    view.setUint32(20 + i * 4, value, true);
  });
  view.setUint32(40, Math.floor(state.baseTimeMs / 1000), true);
  return out;
}

export function deserializeRtc(data: Uint8Array): RtcState | null {
  if (data.length < 44) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dh = view.getUint32(16, true) & 0xff;
  return {
    seconds: view.getUint32(0, true) & 0x3f,
    minutes: view.getUint32(4, true) & 0x3f,
    hours: view.getUint32(8, true) & 0x1f,
    days: (view.getUint32(12, true) & 0xff) | ((dh & 0x01) << 8),
    halted: (dh & 0x40) !== 0,
    dayCarry: (dh & 0x80) !== 0 ? 1 : 0,
    baseTimeMs: view.getUint32(40, true) * 1000,
  };
}

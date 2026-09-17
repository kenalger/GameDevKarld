import type { EmulatorCore } from '@webboy/emulator';
import type { StopCondition } from '../types.js';

/**
 * Blargg convention. Two reporting channels, both supported:
 *
 *  1. Serial (FF01/FF02) — the ROM prints the name of the failing sub-test. This is the
 *     channel worth having: "cpu_instrs failed" is useless next to "06-ld r,r failed".
 *  2. Memory at 0xA000, preceded by signature 0xDE 0xB0 0x61, status byte at 0xA000:
 *     0x80 = running, 0x00 = pass, anything else = failure code.
 *
 * Needs the serial stub and memory bus from Phase 02; reports `unavailable` until then.
 */
const SIGNATURE = [0xde, 0xb0, 0x61] as const;
const STATUS_ADDR = 0xa000;
const SIGNATURE_ADDR = 0xa001;
const TEXT_ADDR = 0xa004;
const STILL_RUNNING = 0x80;

export interface SerialSink {
  readonly text: string;
  clear(): void;
}

export function blarggCondition(serial?: SerialSink): StopCondition {
  return {
    name: 'blargg',
    reset() {
      serial?.clear();
    },
    evaluate(core: EmulatorCore) {
      const inspector = core.getInspector();

      const sigOk = SIGNATURE.every((byte, i) => inspector.readMemory(SIGNATURE_ADDR + i) === byte);
      if (sigOk) {
        const status = inspector.readMemory(STATUS_ADDR);
        if (status === STILL_RUNNING) return null;
        const text = readNulTerminated(inspector, TEXT_ADDR, 512);
        return status === 0x00
          ? { outcome: 'pass' as const, detail: text || 'Passed.' }
          : { outcome: 'fail' as const, detail: `Status 0x${status.toString(16)}: ${text}` };
      }

      const out = serial?.text ?? '';
      if (out.includes('Passed')) return { outcome: 'pass' as const, detail: out.trim() };
      if (out.includes('Failed')) return { outcome: 'fail' as const, detail: out.trim() };

      const cpu = inspector.getCpuSnapshot();
      if (cpu.cycles === 0 && cpu.pc === 0 && out === '') {
        return {
          outcome: 'unavailable' as const,
          detail:
            'No serial output and no CPU execution — bus/serial not implemented yet (Phase 02).',
        };
      }
      return null;
    },
  };
}

function readNulTerminated(
  inspector: { readMemory(address: number): number },
  start: number,
  max: number,
): string {
  let out = '';
  for (let i = 0; i < max; i++) {
    const byte = inspector.readMemory(start + i);
    if (byte === 0x00) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

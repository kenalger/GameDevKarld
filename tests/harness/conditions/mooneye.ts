import type { EmulatorCore } from '@webboy/emulator';
import type { StopCondition } from '../types.js';

/**
 * Mooneye / Gekkio convention: the ROM runs `LD B,B` (0x40) when finished.
 *
 *   PASS  — B=3 C=5 D=8 E=13 H=21 L=34 (Fibonacci)
 *   FAIL  — every register is 0x42
 *
 * Detecting the `LD B,B` breakpoint needs a CPU hook that does not exist until Phase 01,
 * so until then this reports `unavailable` rather than guessing.
 */
export const FIBONACCI_SIGNATURE = { b: 3, c: 5, d: 8, e: 13, h: 21, l: 34 } as const;
const FAILURE_BYTE = 0x42;

export function mooneyeCondition(): StopCondition {
  return {
    name: 'mooneye',
    evaluate(core: EmulatorCore) {
      const cpu = core.getInspector().getCpuSnapshot();

      // A core reporting no execution at all cannot be judged either way.
      if (cpu.cycles === 0) {
        return {
          outcome: 'unavailable' as const,
          detail: 'CPU inspection reports no execution — core cannot run this ROM.',
        };
      }

      const { b, c, d, e, h, l } = cpu;
      const sig = FIBONACCI_SIGNATURE;
      if (b === sig.b && c === sig.c && d === sig.d && e === sig.e && h === sig.h && l === sig.l) {
        return { outcome: 'pass' as const, detail: 'Fibonacci register signature matched.' };
      }
      if ([b, c, d, e, h, l].every((r) => r === FAILURE_BYTE)) {
        return {
          outcome: 'fail' as const,
          detail: 'Registers all 0x42 — test ROM reported failure.',
        };
      }
      return null;
    },
  };
}

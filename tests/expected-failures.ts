/**
 * Tests that are known to fail for a recorded reason.
 *
 * The charter's rule: moving a test here is an explicit decision that must carry a
 * subsystem and a written justification. It is NOT a place to hide a regression.
 *
 * Only genuinely-not-applicable tests belong here. Work that a later phase will do stays
 * a plain `fail` on the scoreboard, so the debt remains visible.
 */
export const EXPECTED_FAILURES = new Map<string, { subsystem: string; reason: string }>([
  // WebBoy emulates a DMG-ABC. These check the post-boot state of other models, which
  // differ in their boot ROMs and would require emulating those machines.
  ...(
    [
      'boot_div-dmg0',
      'boot_div-S',
      'boot_div2-S',
      'boot_hwio-dmg0',
      'boot_hwio-S',
      'boot_regs-dmg0',
      'boot_regs-mgb',
      'boot_regs-sgb',
      'boot_regs-sgb2',
    ] as const
  ).map(
    (name) =>
      [
        `mooneye/acceptance/${name}`,
        {
          subsystem: 'CPU/boot',
          reason:
            'Model-specific: WebBoy emulates a DMG-ABC. dmg0/mgb/sgb/sgb2/SGB have different boot state.',
        },
      ] as const,
  ),
]);

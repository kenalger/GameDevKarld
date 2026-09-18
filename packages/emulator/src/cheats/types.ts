/**
 * Cheat codes, decoded.
 *
 * The two GB formats are different mechanisms wearing one name, and conflating them is how
 * you ship codes that silently do nothing:
 *
 *  - **Game Genie** is a pass-through adapter on the cartridge bus. It watches the address
 *    lines and substitutes a byte as the game READS it, forever, and can therefore patch
 *    ROM. Its compare byte is why it survives bank switching without tracking banks.
 *  - **GameShark** hooks the VBlank handler and WRITES to RAM once per frame. It is code
 *    running on the CPU, so it cannot touch ROM and only fires while the interrupt runs.
 *
 * Source: Pan Docs, "Game Genie/Shark Cheats" — https://gbdev.io/pandocs/Shark_Cheats.html
 */

export type CheatFormat = 'game-genie' | 'gameshark';

/** A Game Genie code: substitute a byte on the ROM read path. */
export interface GameGenieCheat {
  readonly format: 'game-genie';
  /** 0x0000-0x7FFF. The encoding cannot express anything higher. */
  readonly address: number;
  readonly value: number;
  /**
   * The byte the cartridge must currently be returning for the patch to apply.
   *
   * `null` for the 6-character form, which patches unconditionally — and therefore in
   * EVERY bank, which is only safe on a game that does not bank.
   */
  readonly compare: number | null;
}

/** A GameShark code: write a byte to RAM once per frame. */
export interface GameSharkCheat {
  readonly format: 'gameshark';
  /** The type byte. Pan Docs calls it "SRAM bank"; implementations treat it as a type. */
  readonly type: number;
  readonly address: number;
  readonly value: number;
}

export type ParsedCheat = GameGenieCheat | GameSharkCheat;

/** Why a code was rejected. The UI turns these into sentences, so they must be specific. */
export type CheatParseFailure =
  | 'empty'
  | 'unrecognised-shape'
  | 'not-hex'
  | 'game-genie-address-out-of-range'
  | 'gameshark-unsupported-type';

export class CheatParseError extends Error {
  constructor(
    readonly reason: CheatParseFailure,
    message: string,
  ) {
    super(message);
    this.name = 'CheatParseError';
  }
}

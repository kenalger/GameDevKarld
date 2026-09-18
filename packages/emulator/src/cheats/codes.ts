import {
  CheatParseError,
  type GameGenieCheat,
  type GameSharkCheat,
  type ParsedCheat,
} from './types.js';

/**
 * Game Genie and GameShark decoding for Game Boy.
 *
 * Every rule here comes from Pan Docs, "Game Genie/Shark Cheats"
 * (https://gbdev.io/pandocs/Shark_Cheats.html), which gives the field layout as:
 *
 *   AB   new data
 *   FCDE memory address, XORed by $F000
 *   GI   old data, XORed by $BA and rotated left by two
 *   H    Unknown, maybe checksum and/or else
 *
 * That describes the ENCODE direction, so decoding rotates right by two and then XORs.
 * The ordering matters more than it looks: `ror8(x ^ 0xBA, 2)` instead of
 * `ror8(x, 2) ^ 0xBA` still round-trips perfectly while getting all 256 possible compare
 * bytes wrong. The tests therefore assert literal values, never a round trip.
 */

/** Rotate an 8-bit value right. */
function ror8(value: number, bits: number): number {
  return ((value >>> bits) | (value << (8 - bits))) & 0xff;
}

const HEX = /^[0-9a-fA-F]+$/;

function nibbles(text: string): number[] {
  if (!HEX.test(text)) {
    throw new CheatParseError('not-hex', `"${text}" contains something that is not a hex digit.`);
  }
  return [...text].map((character) => parseInt(character, 16));
}

/**
 * Strips separators and normalises case.
 *
 * Codes are written with dashes, without them, in either case, and pasted with stray
 * whitespace. All of those are the same code.
 */
export function normaliseCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Decodes a Game Genie code, 9 characters or 6.
 *
 * The 6-character form has no compare byte and so patches in EVERY bank — the compare is
 * precisely what makes the 9-character form bank-safe, because the adapter substitutes
 * only when the byte the cartridge is returning matches.
 */
export function decodeGameGenie(raw: string): GameGenieCheat {
  const code = normaliseCode(raw);
  if (code.length !== 9 && code.length !== 6) {
    throw new CheatParseError(
      'unrecognised-shape',
      'A Game Genie code has 9 characters (ABC-DEF-GHI) or 6 (ABC-DEF).',
    );
  }

  const n = nibbles(code);
  const [a, b, c, d, e, f] = n as [number, number, number, number, number, number];

  const value = (a << 4) | b;
  // The high nibble is stored XORed with 0xF, which is also why a well-formed code can
  // never address above 0x7FFF: it would need F < 8.
  const address = ((f ^ 0xf) << 12) | (c << 8) | (d << 4) | e;

  if (address > 0x7fff) {
    throw new CheatParseError(
      'game-genie-address-out-of-range',
      'A Game Genie patches the cartridge as it is read, so it can only target ROM ' +
        '(0x0000-0x7FFF). This code points outside it — it may be a GameShark code.',
    );
  }

  let compare: number | null = null;
  if (code.length === 9) {
    const g = n[6]!;
    const i = n[8]!;
    // n[7] is the H nibble. Pan Docs: "Unknown, maybe checksum and/or else". Every
    // implementation surveyed ignores it in the decode, and so do we.
    compare = ror8((g << 4) | i, 2) ^ 0xba;
  }

  return { format: 'game-genie', address, value, compare };
}

/** Type bytes we apply. See `decodeGameShark` for why the rest are refused. */
const SUPPORTED_GAMESHARK_TYPES = new Set([0x01, 0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97]);

/**
 * Decodes an 8-character GameShark code, `ttvvaaaa`.
 *
 * The address is LITTLE-ENDIAN in the code string: Pan Docs' own example, `010238CD`,
 * "writes $02 at address $CD38".
 *
 * `tt` is labelled "SRAM bank" by Pan Docs but every implementation treats it as a code
 * type: `01` is a plain write, `9b` switches WRAM bank `b` first (CGB only). `8b`, which
 * selects a cartridge RAM bank, is deliberately NOT supported — applying it means writing
 * to the MBC control registers behind the game's back, and on MBC1 that can also change
 * which ROM bank is mapped. Refusing is better than silently desynchronising the mapper.
 */
export function decodeGameShark(raw: string): GameSharkCheat {
  const code = normaliseCode(raw);
  if (code.length !== 8) {
    throw new CheatParseError(
      'unrecognised-shape',
      'A GameShark code is 8 hex characters, like 010238CD.',
    );
  }

  const n = nibbles(code);
  const type = (n[0]! << 4) | n[1]!;
  const value = (n[2]! << 4) | n[3]!;
  const address = (n[6]! << 12) | (n[7]! << 8) | (n[4]! << 4) | n[5]!;

  if (!SUPPORTED_GAMESHARK_TYPES.has(type)) {
    throw new CheatParseError(
      'gameshark-unsupported-type',
      `GameShark code type 0x${type.toString(16).padStart(2, '0').toUpperCase()} is not supported. ` +
        'WebBoy applies type 01 (write) and 9x (write with a WRAM bank switch).',
    );
  }

  return { format: 'gameshark', type, address, value };
}

/**
 * Decodes a code without being told which format it is.
 *
 * On Game Boy the two shapes are disjoint — 9 or 6 characters for Game Genie, 8 for
 * GameShark — so there is no decision to delegate to the player.
 */
export function decodeCheat(raw: string): ParsedCheat {
  const code = normaliseCode(raw);
  if (code.length === 0) throw new CheatParseError('empty', 'Enter a code.');

  if (code.length === 9 || code.length === 6) return decodeGameGenie(code);
  if (code.length === 8) return decodeGameShark(code);

  throw new CheatParseError(
    'unrecognised-shape',
    `"${raw.trim()}" is not a Game Boy cheat code. Game Genie codes look like ABC-DEF-GHI ` +
      'or ABC-DEF; GameShark codes are 8 hex characters.',
  );
}

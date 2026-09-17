const R8 = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'] as const;
const R16 = ['BC', 'DE', 'HL', 'SP'] as const;
const R16_STACK = ['BC', 'DE', 'HL', 'AF'] as const;
const CONDITION = ['NZ', 'Z', 'NC', 'C'] as const;
const ALU = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '] as const;
const CB_OPS = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SWAP', 'SRL'] as const;

export interface Instruction {
  readonly address: number;
  readonly text: string;
  /** Instruction length in bytes, so a listing can step to the next one. */
  readonly length: number;
  readonly bytes: readonly number[];
}

const hex2 = (n: number): string => `$${n.toString(16).padStart(2, '0').toUpperCase()}`;
const hex4 = (n: number): string => `$${n.toString(16).padStart(4, '0').toUpperCase()}`;
const signed = (n: number): string => {
  const value = (n << 24) >> 24;
  return value < 0 ? `-${hex2(-value)}` : `+${hex2(value)}`;
};

/**
 * Disassembles one instruction.
 *
 * `read` should bypass bus side effects where possible — the debugger must never change
 * what it is observing, and reading an I/O register to render a listing would do exactly
 * that.
 */
export function disassemble(address: number, read: (address: number) => number): Instruction {
  const bytes: number[] = [];
  let cursor = address;
  const next = (): number => {
    const byte = read(cursor++) & 0xff;
    bytes.push(byte);
    return byte;
  };

  const opcode = next();
  const text = decode(opcode, next);
  return { address, text, length: bytes.length, bytes };
}

/** Disassembles `count` instructions starting at `address`. */
export function disassembleRange(
  address: number,
  count: number,
  read: (address: number) => number,
): Instruction[] {
  const out: Instruction[] = [];
  let cursor = address & 0xffff;
  for (let i = 0; i < count; i++) {
    const instruction = disassemble(cursor, read);
    out.push(instruction);
    cursor = (cursor + instruction.length) & 0xffff;
  }
  return out;
}

function decode(opcode: number, next: () => number): string {
  const d8 = (): string => hex2(next());
  const d16 = (): string => {
    const lo = next();
    return hex4((next() << 8) | lo);
  };
  const r8 = (): string => signed(next());

  // 0x40-0x7F: LD r,r' — one regular block, minus HALT.
  if (opcode >= 0x40 && opcode <= 0x7f) {
    if (opcode === 0x76) return 'HALT';
    return `LD ${R8[(opcode >> 3) & 7]},${R8[opcode & 7]}`;
  }

  // 0x80-0xBF: ALU A,r
  if (opcode >= 0x80 && opcode <= 0xbf) {
    return `${ALU[(opcode >> 3) & 7]}${R8[opcode & 7]}`;
  }

  switch (opcode) {
    case 0x00:
      return 'NOP';
    case 0x07:
      return 'RLCA';
    case 0x0f:
      return 'RRCA';
    case 0x10:
      return 'STOP';
    case 0x17:
      return 'RLA';
    case 0x1f:
      return 'RRA';
    case 0x18:
      return `JR ${r8()}`;
    case 0x27:
      return 'DAA';
    case 0x2f:
      return 'CPL';
    case 0x37:
      return 'SCF';
    case 0x3f:
      return 'CCF';
    case 0x08:
      return `LD (${d16()}),SP`;
    case 0x02:
      return 'LD (BC),A';
    case 0x12:
      return 'LD (DE),A';
    case 0x22:
      return 'LD (HL+),A';
    case 0x32:
      return 'LD (HL-),A';
    case 0x0a:
      return 'LD A,(BC)';
    case 0x1a:
      return 'LD A,(DE)';
    case 0x2a:
      return 'LD A,(HL+)';
    case 0x3a:
      return 'LD A,(HL-)';
    case 0xc3:
      return `JP ${d16()}`;
    case 0xc9:
      return 'RET';
    case 0xcd:
      return `CALL ${d16()}`;
    case 0xd9:
      return 'RETI';
    case 0xe0:
      return `LDH (${d8()}),A`;
    case 0xf0:
      return `LDH A,(${d8()})`;
    case 0xe2:
      return 'LD (C),A';
    case 0xf2:
      return 'LD A,(C)';
    case 0xe8:
      return `ADD SP,${r8()}`;
    case 0xe9:
      return 'JP (HL)';
    case 0xea:
      return `LD (${d16()}),A`;
    case 0xfa:
      return `LD A,(${d16()})`;
    case 0xf3:
      return 'DI';
    case 0xfb:
      return 'EI';
    case 0xf8:
      return `LD HL,SP${r8()}`;
    case 0xf9:
      return 'LD SP,HL';
    case 0xcb: {
      const sub = next();
      const target = R8[sub & 7];
      if (sub < 0x40) return `${CB_OPS[(sub >> 3) & 7]} ${target}`;
      const bit = (sub >> 3) & 7;
      if (sub < 0x80) return `BIT ${bit},${target}`;
      if (sub < 0xc0) return `RES ${bit},${target}`;
      return `SET ${bit},${target}`;
    }
    default:
      break;
  }

  // Regular sub-blocks in 0x00-0x3F and 0xC0-0xFF.
  const pair = (opcode >> 4) & 3;
  switch (opcode & 0x0f) {
    case 0x01:
      if (opcode < 0x40) return `LD ${R16[pair]},${d16()}`;
      break;
    case 0x03:
      if (opcode < 0x40) return `INC ${R16[pair]}`;
      break;
    case 0x09:
      if (opcode < 0x40) return `ADD HL,${R16[pair]}`;
      break;
    case 0x0b:
      if (opcode < 0x40) return `DEC ${R16[pair]}`;
      break;
    default:
      break;
  }
  if (opcode < 0x40) {
    const low = opcode & 7;
    const target = R8[(opcode >> 3) & 7];
    if (low === 4) return `INC ${target}`;
    if (low === 5) return `DEC ${target}`;
    if (low === 6) return `LD ${target},${d8()}`;
    if (low === 0 && opcode >= 0x20) return `JR ${CONDITION[((opcode >> 3) & 3) - 0]},${r8()}`;
  }

  if (opcode >= 0xc0) {
    const condition = CONDITION[(opcode >> 3) & 3];
    switch (opcode & 0x0f) {
      case 0x00:
        if (opcode < 0xe0) return `RET ${condition}`;
        break;
      case 0x01:
        return `POP ${R16_STACK[pair]}`;
      case 0x02:
        if (opcode < 0xe0) return `JP ${condition},${d16()}`;
        break;
      case 0x04:
        if (opcode < 0xe0) return `CALL ${condition},${d16()}`;
        break;
      case 0x05:
        return `PUSH ${R16_STACK[pair]}`;
      case 0x06:
        return `${ALU[(opcode >> 3) & 7]}${d8()}`;
      case 0x07:
        return `RST ${hex2(opcode & 0x38)}`;
      case 0x08:
        if (opcode < 0xe0) return `RET ${condition}`;
        break;
      case 0x0e:
        return `${ALU[(opcode >> 3) & 7]}${d8()}`;
      case 0x0f:
        return `RST ${hex2(opcode & 0x38)}`;
      default:
        break;
    }
  }

  return `DB ${hex2(opcode)}`;
}

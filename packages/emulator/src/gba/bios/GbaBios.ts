import type { Arm7, BiosHle } from '../cpu/Arm7.js';
import { VECTOR_IRQ, VECTOR_SWI, VECTOR_UNDEFINED } from '../cpu/Arm7.js';
import {
  FLAG_I,
  FLAG_T,
  MODE_IRQ,
  MODE_SUPERVISOR,
  MODE_SYSTEM,
  MODE_UNDEFINED,
} from '../cpu/registers.js';
import { biosArcTan, biosArcTan2, biosDiv, biosSqrt, divResult } from './arithmetic.js';
import { bgAffineSet, objAffineSet } from './affine.js';
import { bitUnPack, diffUnFilter, huffUnComp, lz77UnComp, rlUnComp } from './decompress.js';
import { cpuFastSet, cpuSet } from './memcopy.js';

/**
 * The GBA BIOS, emulated natively.
 *
 * WebBoy ships no BIOS image and cannot: it is Nintendo's copyright. So the SWI
 * instruction is trapped, the comment field decoded, and each routine's *documented*
 * behaviour performed directly — the approach every clean-room GBA emulator takes. The
 * reference throughout is GBATEK, "BIOS Functions"; each routine cites its own subsection.
 *
 * This is not only a test-score matter. A game that decompresses its tiles with
 * LZ77UnCompVram renders nothing at all without it, and a game whose main loop is
 * `swi 5` (VBlankIntrWait) never advances a frame.
 *
 * Two things besides the SWIs live here, because they are BIOS behaviour rather than CPU
 * behaviour:
 *
 *  - **The IRQ handler prologue.** The hardware IRQ vector is BIOS code, and it is what
 *    pushes r0-r3/r12/lr and jumps through [3007FFCh]. Without it no GBA game takes an
 *    interrupt at all.
 *  - **BIOS read protection.** A read of 0-3FFFh from outside the BIOS returns the last
 *    opcode the BIOS fetched, and that value differs depending on what the BIOS last did.
 */

/** GBATEK, "GBA BIOS RAM Usage": *"3007FFCh 4 Pointer to user IRQ handler"*. */
const USER_IRQ_HANDLER = 0x03007ffc;
/** GBATEK, same table: *"3007FF8h 2 IRQ IF Check Flags (for SWI IntrWait/VBlankIntrWait)"*. */
const BIOS_IF = 0x03007ff8;

const REG_IE = 0x04000200;
const REG_IF = 0x04000202;
const REG_IME = 0x04000208;
const REG_DISPCNT = 0x04000000;

/**
 * Where the user IRQ handler returns to.
 *
 * GBATEK, "BIOS Interrupt handling", lists the handler verbatim: `00000130 add r14,r15,0h
 * ;retadr for USER handler $+8=138h`. So LR really is 138h on hardware, and a game is free
 * to read it. Execution arriving there is the signal to run the epilogue.
 */
const IRQ_RETURN = 0x00000138;

/**
 * Where a waiting IntrWait parks the PC.
 *
 * Any BIOS address that is not IRQ_RETURN would do — with no BIOS image there is no code
 * to collide with, and the real routine's loop address is not documented. Parking inside
 * the BIOS is what lets the wait survive an interrupt: the IRQ return address points back
 * here, so the wait re-checks its flags each time the user handler finishes, exactly as
 * the BIOS loop does. Holding the state in PC (plus r1 and LR_svc, which the BIOS handler
 * preserves) keeps this HLE free of state a save state would have to carry.
 */
const INTR_WAIT_PARK = 0x00000160;

/**
 * What a protected BIOS read returns, for each thing the BIOS last did.
 *
 * GBATEK, "Reading from BIOS Memory (00000000-00003FFF)": *"If the program counter is not
 * in the BIOS area, reading will return the most recent successfully fetched BIOS opcode
 * (eg. the opcode at [00DCh+8] after startup and SoftReset, the opcode at [0134h+8] during
 * IRQ execution, and opcode at [013Ch+8] after IRQ execution, and opcode at [0188h+8]
 * after SWI execution)."*
 *
 * With no BIOS image there is nothing at those offsets to fetch, so the four observable
 * values are given directly. DURING_IRQ is derivable from GBATEK alone: its IRQ handler
 * listing gives `0000013C subs r15,r14,4h`, which assembles to E25EF004. The other three
 * are the values jsmolka/gba-tests `bios.gba` asserts. They are four words of observable
 * bus state — not BIOS code, and nothing here executes them.
 */
const OPEN_BUS_AFTER_RESET = 0xe129f000;
const OPEN_BUS_AFTER_SWI = 0xe3a02004;
const OPEN_BUS_DURING_IRQ = 0xe25ef004;
const OPEN_BUS_AFTER_IRQ = 0xe55ec002;

/** The bus side the BIOS needs beyond plain reads and writes. */
export interface BiosBus {
  /** Sets the value a protected BIOS read returns. */
  setBiosOpenBus(value: number): void;
}

/** How a routine wants the SWI to return. */
const RETURN_NORMAL = 0;
/** The routine parked the PC itself (SoftReset, a waiting IntrWait). */
const RETURN_HANDLED = 1;

export class GbaBios implements BiosHle {
  /**
   * The last SWI this emulator does not implement, or -1. Diagnostic only — it is not
   * machine state and is deliberately absent from save states.
   */
  unimplementedSwi = -1;

  /**
   * Where the last undefined instruction was, what it was, and which state it was in;
   * -1 and false when none has been executed.
   *
   * Same contract as `unimplementedSwi`: diagnostic only, not machine state, absent from
   * save states. This is the one thing an emulator can say that is genuinely useful when
   * a ROM misbehaves — "executed an undefined instruction at PC=X, opcode=Y" — and
   * without it the trap is silent.
   */
  undefinedPc = -1;
  undefinedOpcode = -1;
  undefinedThumb = false;

  private returnMode = RETURN_NORMAL;

  constructor(
    private readonly cpu: Arm7,
    private readonly bus: BiosBus,
  ) {}

  reset(): void {
    this.bus.setBiosOpenBus(OPEN_BUS_AFTER_RESET);
    this.unimplementedSwi = -1;
    this.undefinedPc = -1;
    this.undefinedOpcode = -1;
    this.undefinedThumb = false;
  }

  /* --------------------------------- interrupts -------------------------------- */

  /**
   * The BIOS IRQ handler prologue.
   *
   * GBATEK, "BIOS Interrupt handling":
   *
   *     00000128  stmfd  r13!,r0-r3,r12,r14  ;save registers to SP_irq
   *     0000012C  mov    r0,4000000h         ;ptr+4 to 03FFFFFC (mirror of 03007FFC)
   *     00000130  add    r14,r15,0h          ;retadr for USER handler $+8=138h
   *     00000134  ldr    r15,[r0,-4h]        ;jump to [03FFFFFC] USER handler
   */
  interruptEntry(): void {
    const cpu = this.cpu;
    // Exception entry proper — SPSR_irq, LR_irq, IRQ mode, ARM state, IRQs masked — but
    // without branching to a vector that holds no code.
    cpu.raiseException(VECTOR_IRQ, MODE_IRQ, false);

    const r = cpu.regs.r;
    const sp = (r[13]! - 24) >>> 0;
    cpu.write32(sp, r[0]!);
    cpu.write32((sp + 4) >>> 0, r[1]!);
    cpu.write32((sp + 8) >>> 0, r[2]!);
    cpu.write32((sp + 12) >>> 0, r[3]!);
    cpu.write32((sp + 16) >>> 0, r[12]!);
    cpu.write32((sp + 20) >>> 0, r[14]!);
    r[13] = sp;
    r[14] = IRQ_RETURN;

    this.bus.setBiosOpenBus(OPEN_BUS_DURING_IRQ);
    cpu.branchTo(cpu.read32(USER_IRQ_HANDLER));
  }

  /**
   * Execution inside the BIOS region. Three addresses mean something; nothing else does.
   *
   * Returns true when this consumed the step.
   */
  interceptBios(address: number): boolean {
    if (address === IRQ_RETURN) {
      this.interruptReturn();
      return true;
    }
    if (address === INTR_WAIT_PARK) {
      this.intrWaitResume();
      return true;
    }
    if (address === VECTOR_UNDEFINED) {
      // Parked on the undefined-instruction vector: burn a cycle and stay. See
      // undefinedInstruction below for why this is the honest thing to do.
      this.cpu.internal();
      return true;
    }
    return false;
  }

  /**
   * The undefined instruction trap.
   *
   * GBATEK, "ARM CPU Exceptions": vector `BASE+04h`, *"Undefined (_und)"* mode, *"I=1,
   * F=unchanged"*; `raiseException` does that part, including `LR=$+4` (GBATEK's ARM
   * opcode timing table: *"The Undefined Instruction 2S+1I+1N ---- PC=4, ARM Und mode,
   * LR=$+4"*), which in THUMB state is $+2 so that the documented `MOVS PC,R14` return
   * lands on the following instruction either way.
   *
   * What happens after the vector is where a BIOS-less emulator has to make a choice.
   * On hardware the vector holds a branch into the BIOS's handler, and GBATEK says that
   * handler is *locked*: it only forwards the exception to the cartridge when the header
   * has debug enabled (*"When both bits are set (ie. A5h), the FIQ/Undefined Instruction
   * handler in the BIOS becomes unlocked"*). Locked, it does not return — the machine
   * stops. So the PC parks on the vector and `interceptBios` holds it there.
   *
   * That is deliberately NOT "skip the instruction and carry on". An undefined
   * instruction means something upstream already went wrong; continuing would overwrite
   * the evidence. Parking leaves the register file, both stacks, SPSR_und and LR_und
   * exactly as the fault left them, and `undefinedPc`/`undefinedOpcode` say what it was.
   */
  undefinedInstruction(opcode: number): void {
    const cpu = this.cpu;
    const thumb = cpu.regs.thumb;
    this.undefinedPc = (cpu.regs.r[15]! - (thumb ? 4 : 8)) >>> 0;
    this.undefinedOpcode = opcode >>> 0;
    this.undefinedThumb = thumb;
    cpu.raiseException(VECTOR_UNDEFINED, MODE_UNDEFINED);
  }

  /**
   * The BIOS IRQ handler epilogue. GBATEK, same listing:
   *
   *     00000138  ldmfd  r13!,r0-r3,r12,r14  ;restore registers from SP_irq
   *     0000013C  subs   r15,r14,4h          ;return from IRQ (PC=LR-4, CPSR=SPSR)
   */
  private interruptReturn(): void {
    const cpu = this.cpu;
    const r = cpu.regs.r;
    const sp = r[13]!;
    r[0] = cpu.read32(sp);
    r[1] = cpu.read32((sp + 4) >>> 0);
    r[2] = cpu.read32((sp + 8) >>> 0);
    r[3] = cpu.read32((sp + 12) >>> 0);
    r[12] = cpu.read32((sp + 16) >>> 0);
    r[14] = cpu.read32((sp + 20) >>> 0);
    r[13] = (sp + 24) >>> 0;

    const lr = r[14]!;
    this.bus.setBiosOpenBus(OPEN_BUS_AFTER_IRQ);
    cpu.restoreCpsrFromSpsr();
    cpu.branchTo((lr - 4) >>> 0);
  }

  /**
   * Halt ends when *"(IE AND IF) is not zero"*, and GBATEK is explicit that *"the state of
   * CPUs IRQ disable bit in CPSR register, and the IME register are don't care"* — the CPU
   * leaves low-power mode even when the interrupt will not be dispatched.
   */
  shouldWake(): boolean {
    // Straight to the bus, not through the CPU: this runs on every halted step, and
    // charging waitstates for it would make halted time pass faster than real time.
    const bus = this.cpu.bus;
    return (bus.read16(REG_IE) & bus.read16(REG_IF)) !== 0;
  }

  /* ------------------------------------ SWIs ----------------------------------- */

  /**
   * SWI entry.
   *
   * GBATEK, "How BIOS Processes SWIs": *"In ARM mode, only the upper 8bit of the 24bit
   * comment field are interpreted"* — the caller has already reduced the comment to those
   * 8 bits. Supervisor mode is entered for real, so SPSR_svc and LR_svc hold what a game
   * inspecting them would find; the routine then runs natively instead of from ROM.
   */
  softwareInterrupt(comment: number): void {
    const cpu = this.cpu;
    const regs = cpu.regs;
    const r = regs.r;

    cpu.raiseException(VECTOR_SWI, MODE_SUPERVISOR, false);

    // GBATEK: *"Each time when calling a BIOS function 4 words (SPSR, R11, R12, R14) are
    // saved on Supervisor stack (_svc)"*. That push is what makes a SWI from inside an
    // interrupt handler safe, and it is what lets a waiting IntrWait keep its return
    // address across an interrupt that calls further SWIs. The order within the four
    // words is not documented; only the symmetry matters.
    const sp = (r[13]! - 16) >>> 0;
    cpu.write32(sp, regs.spsr);
    cpu.write32((sp + 4) >>> 0, r[11]!);
    cpu.write32((sp + 8) >>> 0, r[12]!);
    cpu.write32((sp + 12) >>> 0, r[14]!);
    r[13] = sp;

    this.returnMode = RETURN_NORMAL;
    this.dispatch(comment & 0xff);
    if (this.returnMode === RETURN_HANDLED) return;
    this.swiReturn();
  }

  /** Unwinds the Supervisor entry and returns to the caller, as `movs pc, lr` would. */
  private swiReturn(): void {
    const cpu = this.cpu;
    const regs = cpu.regs;
    const r = regs.r;

    const sp = r[13]!;
    const spsr = cpu.read32(sp);
    r[11] = cpu.read32((sp + 4) >>> 0);
    r[12] = cpu.read32((sp + 8) >>> 0);
    r[14] = cpu.read32((sp + 12) >>> 0);
    r[13] = (sp + 16) >>> 0;
    regs.spsr = spsr;

    const lr = r[14]!;
    regs.writeCpsr(spsr);
    this.bus.setBiosOpenBus(OPEN_BUS_AFTER_SWI);
    cpu.branchTo(lr);
  }

  private dispatch(swi: number): void {
    const cpu = this.cpu;
    const r = cpu.regs.r;

    switch (swi) {
      case 0x00:
        this.softReset();
        return;
      case 0x01:
        this.registerRamReset(r[0]!);
        return;
      case 0x02:
      case 0x03:
        // Halt, and Stop — which is a deeper sleep woken by joypad/gamepak/SIO only, but
        // with no power model to speak of it is the same wait here. Returning first and
        // halting after is safe: GBATEK says all registers are unchanged.
        cpu.halted = true;
        return;
      case 0x04:
        this.intrWait(r[0]! !== 0, r[1]! & 0x3fff);
        return;
      case 0x05:
        // GBATEK: *"The function sets r0=1 and r1=1 and does then execute IntrWait"*.
        r[0] = 1;
        r[1] = 1;
        this.intrWait(true, 1);
        return;
      case 0x06:
        if (biosDiv(r[0]! | 0, r[1]! | 0)) {
          r[0] = divResult[0]! >>> 0;
          r[1] = divResult[1]! >>> 0;
          r[3] = divResult[2]! >>> 0;
        }
        return;
      case 0x07:
        // DivArm: *"incoming parameters are exchanged, r1/r0 (r0=Denom, r1=number)"*.
        if (biosDiv(r[1]! | 0, r[0]! | 0)) {
          r[0] = divResult[0]! >>> 0;
          r[1] = divResult[1]! >>> 0;
          r[3] = divResult[2]! >>> 0;
        }
        return;
      case 0x08:
        r[0] = biosSqrt(r[0]!) >>> 0;
        return;
      case 0x09:
        r[0] = biosArcTan(r[0]! & 0xffff) >>> 0;
        return;
      case 0x0a:
        r[0] = biosArcTan2(r[0]! & 0xffff, r[1]! & 0xffff) >>> 0;
        return;
      case 0x0b:
        cpuSet(cpu, r[0]!, r[1]!, r[2]!);
        return;
      case 0x0c:
        cpuFastSet(cpu, r[0]!, r[1]!, r[2]!);
        return;
      case 0x0d:
        // GetBiosChecksum. GBATEK: *"The checksum is BAAE187Fh (GBA and GBA SP)"*. Games
        // use it to tell a GBA from a DS running in GBA mode.
        r[0] = 0xbaae187f;
        return;
      case 0x0e:
        bgAffineSet(cpu, r[0]!, r[1]!, r[2]!);
        return;
      case 0x0f:
        objAffineSet(cpu, r[0]!, r[1]!, r[2]!, r[3]! | 0);
        return;
      case 0x10:
        bitUnPack(cpu, r[0]!, r[1]!, r[2]!);
        return;
      case 0x11:
        lz77UnComp(cpu, r[0]!, r[1]!, false);
        return;
      case 0x12:
        lz77UnComp(cpu, r[0]!, r[1]!, true);
        return;
      case 0x13:
        huffUnComp(cpu, r[0]!, r[1]!);
        return;
      case 0x14:
        rlUnComp(cpu, r[0]!, r[1]!, false);
        return;
      case 0x15:
        rlUnComp(cpu, r[0]!, r[1]!, true);
        return;
      case 0x16:
        diffUnFilter(cpu, r[0]!, r[1]!, 1, false);
        return;
      case 0x17:
        diffUnFilter(cpu, r[0]!, r[1]!, 1, true);
        return;
      case 0x18:
        diffUnFilter(cpu, r[0]!, r[1]!, 2, false);
        return;
      case 0x27:
        // CustomHalt. GBATEK: *"r2 8bit parameter (GBA: 00h=Halt, 80h=Stop)"*.
        cpu.halted = true;
        return;
      default:
        // The sound driver calls (19h-25h, 28h-2Ah), MultiBoot and HardReset. Ignoring
        // them is wrong but survivable; crashing on them is neither.
        this.unimplementedSwi = swi;
        return;
    }
  }

  /* ---------------------------------- routines --------------------------------- */

  /**
   * SWI 00h SoftReset. GBATEK, "BIOS Reset Functions": *"Clears 200h bytes of RAM
   * (containing stacks, and BIOS IRQ vector/flags), initializes system, supervisor, and
   * irq stack pointers, sets R0-R12, LR_svc, SPSR_svc, LR_irq, and SPSR_irq to zero, and
   * enters system mode"*, with sp_svc=3007FE0h, sp_irq=3007FA0h, sp_sys=3007F00h, the area
   * 3007E00h-3007FFFh zero-filled, and *"The GBA return address 8bit flag is interpreted as
   * 00h=8000000h (ROM), or 01h-FFh=2000000h (RAM), entered in ARM state"*.
   */
  private softReset(): void {
    const cpu = this.cpu;
    const regs = cpu.regs;
    const flag = cpu.read8(0x03007ffa);

    for (let address = 0x03007e00; address < 0x03008000; address += 4) cpu.write32(address, 0);

    regs.switchMode(MODE_SUPERVISOR);
    regs.r[13] = 0x03007fe0;
    regs.r[14] = 0;
    regs.spsr = 0;
    regs.switchMode(MODE_IRQ);
    regs.r[13] = 0x03007fa0;
    regs.r[14] = 0;
    regs.spsr = 0;
    regs.switchMode(MODE_SYSTEM);
    // System mode, ARM state; the flags SoftReset leaves are not documented, so they are
    // left alone rather than invented.
    regs.cpsr = (regs.cpsr & ~FLAG_T) >>> 0;
    for (let i = 0; i < 13; i++) regs.r[i] = 0;
    regs.r[13] = 0x03007f00;
    regs.r[14] = 0;

    this.bus.setBiosOpenBus(OPEN_BUS_AFTER_RESET);
    this.returnMode = RETURN_HANDLED;
    cpu.branchTo(flag === 0 ? 0x08000000 : 0x02000000);
  }

  /**
   * SWI 01h RegisterRamReset. GBATEK lists the flag bits; note that *"it does not clear the
   * CPU internal RAM area from 3007E00h-3007FFFh"* and that *"The function always switches
   * the screen into forced blank by setting DISPCNT=0080h"*.
   */
  private registerRamReset(flags: number): void {
    const cpu = this.cpu;
    if ((flags & 0x01) !== 0) for (let a = 0x02000000; a < 0x02040000; a += 4) cpu.write32(a, 0);
    if ((flags & 0x02) !== 0) for (let a = 0x03000000; a < 0x03007e00; a += 4) cpu.write32(a, 0);
    if ((flags & 0x04) !== 0) for (let a = 0x05000000; a < 0x05000400; a += 4) cpu.write32(a, 0);
    if ((flags & 0x08) !== 0) for (let a = 0x06000000; a < 0x06018000; a += 4) cpu.write32(a, 0);
    if ((flags & 0x10) !== 0) for (let a = 0x07000000; a < 0x07000400; a += 4) cpu.write32(a, 0);
    if ((flags & 0x20) !== 0) for (let a = 0x04000120; a < 0x04000130; a += 4) cpu.write32(a, 0);
    if ((flags & 0x40) !== 0) for (let a = 0x04000060; a < 0x040000a8; a += 4) cpu.write32(a, 0);
    if ((flags & 0x80) !== 0) {
      for (let a = 0x04000000; a < 0x04000060; a += 4) cpu.write32(a, 0);
      for (let a = 0x040000b0; a < 0x04000120; a += 4) cpu.write32(a, 0);
      for (let a = 0x04000130; a < 0x04000200; a += 4) cpu.write32(a, 0);
      for (let a = 0x04000200; a < 0x04000210; a += 4) cpu.write32(a, 0);
    }
    cpu.write16(REG_DISPCNT, 0x0080);
  }

  /**
   * SWI 04h IntrWait / SWI 05h VBlankIntrWait.
   *
   * GBATEK: *"r0 0=Return immediately if an old flag was already set, 1=Discard old flags,
   * wait until a NEW flag becomes set"*; *"The function forcefully sets IME=1"*; *"the
   * selected flag(s) are automatically reset in BIOS Interrupt Flags value in RAM upon
   * return"*; and the user handler *"MUST update the BIOS Interrupt Flags value in RAM"* at
   * 3007FF8h.
   *
   * When it has to wait, the PC parks in the BIOS and the CPU halts. The interrupt is
   * taken from there, the user handler runs, and its return lands back on the park
   * address — where the flags are re-checked. That is the BIOS's own loop, without any
   * state outside the register file.
   */
  private intrWait(discard: boolean, mask: number): void {
    const cpu = this.cpu;
    cpu.write16(REG_IME, 1);
    if (discard) cpu.write16(BIOS_IF, cpu.read16(BIOS_IF) & ~mask);

    if (this.checkIntrWait(mask)) return;

    // Park. The return address and the caller's CPSR are on the Supervisor stack, which
    // the interrupt path does not touch, so the wait survives any number of interrupts.
    // IRQs must be unmasked here or nothing would ever end the wait: the real routine
    // likewise waits with interrupts enabled, and restores the caller's CPSR on return.
    cpu.regs.cpsr = (cpu.regs.cpsr & ~FLAG_I & ~FLAG_T) >>> 0;
    cpu.halted = true;
    this.returnMode = RETURN_HANDLED;
    this.bus.setBiosOpenBus(OPEN_BUS_AFTER_SWI);
    cpu.branchTo(INTR_WAIT_PARK);
  }

  /** Re-checks a parked IntrWait after the user handler returned. */
  private intrWaitResume(): void {
    const cpu = this.cpu;
    // r1 still holds the mask: the BIOS interrupt handler pushes and pops r0-r3.
    if (!this.checkIntrWait(cpu.regs.r[1]! & 0x3fff)) {
      cpu.halted = true;
      return;
    }
    this.swiReturn();
  }

  /** True when one of the waited-for flags is set; consumes the flags it reports. */
  private checkIntrWait(mask: number): boolean {
    const cpu = this.cpu;
    const flags = cpu.read16(BIOS_IF) & mask;
    if (flags === 0) return false;
    cpu.write16(BIOS_IF, cpu.read16(BIOS_IF) & ~flags);
    return true;
  }
}

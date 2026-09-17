import { beforeEach, describe, expect, it } from 'vitest';
import { Joypad, buttonBit } from '../../packages/emulator/src/gb/input/Joypad.js';
import { InterruptController, INT_JOYPAD } from '../../packages/emulator/src/gb/cpu/interrupts.js';
import { GameBoyCore } from '../../packages/emulator/src/gb/GameBoyCore.js';
import { buildRom } from '../harness/rom.js';

const SELECT_DIRECTIONS = 0x20; // clear bit 4, leave bit 5 set
const SELECT_ACTIONS = 0x10; // clear bit 5, leave bit 4 set
const SELECT_NEITHER = 0x30;

let interrupts: InterruptController;
let joypad: Joypad;

beforeEach(() => {
  interrupts = new InterruptController();
  joypad = new Joypad(interrupts);
  joypad.reset();
});

describe('joypad register', () => {
  it('always reads the unused top two bits as 1', () => {
    expect(joypad.read() & 0xc0).toBe(0xc0);
  });

  it('reads all ones in the low nibble when nothing is pressed', () => {
    joypad.write(SELECT_DIRECTIONS);
    expect(joypad.read() & 0x0f).toBe(0x0f);
  });

  it('IS INVERTED: a pressed button reads 0', () => {
    joypad.write(SELECT_DIRECTIONS);
    joypad.setState(buttonBit('right'));
    expect(joypad.read() & 0x01).toBe(0);
    expect(joypad.read() & 0x0e).toBe(0x0e); // the others stay released
  });

  it('IS MULTIPLEXED: a row is invisible unless selected', () => {
    joypad.setState(buttonBit('a')); // action row

    joypad.write(SELECT_DIRECTIONS);
    expect(joypad.read() & 0x0f).toBe(0x0f); // wrong row: nothing shows

    joypad.write(SELECT_ACTIONS);
    expect(joypad.read() & 0x01).toBe(0); // A is bit 0 of the action row
  });

  it.each([
    ['right', SELECT_DIRECTIONS, 0x01],
    ['left', SELECT_DIRECTIONS, 0x02],
    ['up', SELECT_DIRECTIONS, 0x04],
    ['down', SELECT_DIRECTIONS, 0x08],
    ['a', SELECT_ACTIONS, 0x01],
    ['b', SELECT_ACTIONS, 0x02],
    ['select', SELECT_ACTIONS, 0x04],
    ['start', SELECT_ACTIONS, 0x08],
  ] as const)('maps %s to the right bit', (button, select, bit) => {
    joypad.write(select);
    joypad.setState(buttonBit(button));
    expect(joypad.read() & bit).toBe(0);
  });

  it('reads all ones when neither row is selected', () => {
    joypad.setState(0xff); // everything held
    joypad.write(SELECT_NEITHER);
    expect(joypad.read() & 0x0f).toBe(0x0f);
  });

  it('combines both rows when both are selected', () => {
    joypad.setState(buttonBit('right') | buttonBit('b'));
    joypad.write(0x00); // both rows selected
    expect(joypad.read() & 0x01).toBe(0); // right, from the direction row
    expect(joypad.read() & 0x02).toBe(0); // b, from the action row
  });

  it('preserves the select bits on read-back', () => {
    joypad.write(SELECT_ACTIONS);
    expect(joypad.read() & 0x30).toBe(SELECT_ACTIONS);
  });
});

describe('joypad interrupt', () => {
  it('fires on a high-to-low transition of a selected line', () => {
    joypad.write(SELECT_DIRECTIONS);
    interrupts.clear(INT_JOYPAD);
    joypad.setState(buttonBit('up'));
    expect(interrupts.pending & INT_JOYPAD || interrupts.if & INT_JOYPAD).toBeTruthy();
  });

  it('does not fire when the pressed button is in an unselected row', () => {
    joypad.write(SELECT_DIRECTIONS);
    interrupts.clear(INT_JOYPAD);
    joypad.setState(buttonBit('start')); // action row, not selected
    expect(interrupts.if & INT_JOYPAD).toBe(0);
  });

  it('does not fire on release', () => {
    joypad.write(SELECT_DIRECTIONS);
    joypad.setState(buttonBit('up'));
    interrupts.clear(INT_JOYPAD);
    joypad.setState(0);
    expect(interrupts.if & INT_JOYPAD).toBe(0);
  });

  it('fires when selecting a row that already has a button held', () => {
    joypad.write(SELECT_NEITHER);
    joypad.setState(buttonBit('down'));
    interrupts.clear(INT_JOYPAD);
    joypad.write(SELECT_DIRECTIONS); // the line now falls
    expect(interrupts.if & INT_JOYPAD).toBeTruthy();
  });
});

describe('joypad through the bus', () => {
  it('is reachable at 0xFF00 and honours setInput', () => {
    const core = new GameBoyCore();
    core.loadRom(buildRom({ cartridgeType: 0x00, romBanks: 2 }));

    core.mmu.write(0xff00, SELECT_ACTIONS);
    expect(core.mmu.read(0xff00) & 0x0f).toBe(0x0f);

    core.setInput(buttonBit('start'));
    expect(core.mmu.read(0xff00) & 0x08).toBe(0);

    core.setInput(0);
    expect(core.mmu.read(0xff00) & 0x0f).toBe(0x0f);
  });

  it('clears every button on reset', () => {
    const core = new GameBoyCore();
    core.loadRom(buildRom({ cartridgeType: 0x00, romBanks: 2 }));
    core.setInput(0xff);
    core.reset();
    core.mmu.write(0xff00, SELECT_DIRECTIONS);
    expect(core.mmu.read(0xff00) & 0x0f).toBe(0x0f);
  });
});

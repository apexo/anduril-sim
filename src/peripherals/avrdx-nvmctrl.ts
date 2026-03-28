// AVR-Dx NVMCTRL + Mapped EEPROM
// EEPROM is memory-mapped at 0x1400-0x14FF and accessed via NVMCTRL commands.

import type { CPU } from 'avr8js/cpu/cpu';
import type { AVRDxCCP } from './avrdx-ccp';

const CTRLA    = 0x0000;
// const CTRLB    = 0x0001;
// const STATUS   = 0x0002;
// const INTCTRL  = 0x0003;
// const INTFLAGS = 0x0004;
// const DATAL    = 0x0006;
// const DATAH    = 0x0007;
// const ADDR0    = 0x0008;
// const ADDR1    = 0x0009;
// const ADDR2    = 0x000A;
// const ADDR3    = 0x000B;

// CMD values
const CMD_NONE_gc           = 0x00;
const CMD_NOOP_gc           = 0x01;
// const CMD_FLWR_gc           = 0x02;
// const CMD_FLPER_gc          = 0x08;
// const CMD_FLMPER2_gc        = 0x09;
// const CMD_FLMPER4_gc        = 0x0A;
// const CMD_FLMPER8_gc        = 0x0B;
// const CMD_FLMPER16_gc       = 0x0C;
// const CMD_FLMPER32_gc       = 0x0D;
const CMD_EEWR_gc           = 0x12;
const CMD_EEERWR_gc         = 0x13;
const CMD_EEBER_gc          = 0x18;
// const CMD_EEMBER2_gc        = 0x19;
// const CMD_EEMBER4_gc        = 0x1A;
// const CMD_EEMBER8_gc        = 0x1B;
// const CMD_EEMBER16_gc       = 0x1C;
// const CMD_EEMBER32_gc       = 0x1D;

export class AVRDxNVMCTRL {
  readonly eeprom: Uint8Array;
  /** Page buffer for EEPROM writes (tracks which bytes have been written) */
  private pageBuffer: Uint8Array;
  private pageBufferDirty: Uint8Array;

  constructor(cpu: CPU, base: number, start: number, private size: number, private ccp: AVRDxCCP, init: undefined | Uint8Array = undefined) {
    this.eeprom = new Uint8Array(size);
    this.pageBuffer = new Uint8Array(size);
    this.pageBufferDirty = new Uint8Array(size);

    this.eeprom.fill(0xFF);
    if (init) this.loadEeprom(init);

    // CTRLA - CCP protected, executes NVM commands
    cpu.writeHooks[base + CTRLA] = (value: number) => {
      if (this.ccp.isUnlocked()) {
        cpu.data[base + CTRLA] = value;
        this.executeCommand(value);
      }
      return true;
    };

    // Mapped EEPROM read hooks (0x1400-0x14FF)
    for (let i = 0; i < size; i++) {
      cpu.readHooks[start + i] = () => this.eeprom[i];

      // Writes to mapped EEPROM go to the page buffer
      cpu.writeHooks[start + i] = (value: number) => {
        this.pageBuffer[i] = value;
        this.pageBufferDirty[i] = 1;

        // Check the current active command
        const cmd = cpu.data[base + CTRLA];

        if (cmd === CMD_EEERWR_gc) {
          // Erase+write: replace byte directly
          this.eeprom[i] = value;
          this.pageBufferDirty[i] = 0;
        } else if (cmd === CMD_EEWR_gc) {
          // Write-only: AND with existing data (can only clear bits)
          this.eeprom[i] &= value;
          this.pageBufferDirty[i] = 0;
        }
        return true;
      };
    }
  }

  loadEeprom(data: Uint8Array) {
    this.eeprom.set(data.subarray(0, this.size));
  }

  private executeCommand(cmd: number) {
    switch (cmd) {
      case CMD_NONE_gc:
      case CMD_NOOP_gc:
        this.pageBufferDirty.fill(0);
        break;
      case CMD_EEWR_gc:
        // Write-only mode: subsequent mapped EEPROM writes AND with existing data.
        // Actual writes happen in the mapped EEPROM write hooks.
        // Don't clear command — it stays active until NONE/NOOP.
        break;
      case CMD_EEERWR_gc:
        // Erase+write mode: subsequent mapped EEPROM writes replace data directly.
        // Actual writes happen in the mapped EEPROM write hooks.
        // Don't clear command — it stays active until NONE/NOOP.
        break;
      case CMD_EEBER_gc:
        // Erase EEPROM page (the page containing the address in ADDR)
        // For simplicity, erase the whole EEPROM
        // TODO: figure out page size
        this.eeprom.fill(0xFF);
        this.pageBufferDirty.fill(0);
        break;
      default:
        // TODO: implement other commands (if needed)
        break;
    }
  }
}

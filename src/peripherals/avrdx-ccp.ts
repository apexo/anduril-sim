// CCP - Configuration Change Protection
// When 0xD8 (IOREG) or 0x9D (SPM) is written to CCP, a 4-cycle window opens
// during which protected registers can be written.

import type { CPU } from 'avr8js/cpu/cpu';

const ADDR = 0;

const SPM  = 0x9D;
const IOREG = 0xD8;

export class AVRDxCCP {
  private unlockedUntil = -Infinity;

  constructor(private cpu: CPU, base: number) {
    cpu.writeHooks[base + ADDR] = (value) => {
      if (value === IOREG || value === SPM) {
        // TODO: adjust for cycle scaling(?)
        this.unlockedUntil = cpu.cycles + 4;
      }
      cpu.data[base + ADDR] = value;
      return true;
    };
  }

  isUnlocked(): boolean {
    return this.cpu.cycles <= this.unlockedUntil;
  }
}

// AVR-Dx RSTCTRL - Reset Controller
// Handles software reset and reset flags.

import { type CPU } from 'avr8js/cpu/cpu';
import { type AVRDxCCP } from './avrdx-ccp';

export const RSTFR = 0;
export const SWRR  = 1;
export const SWRST_bm = 0x01;

export class AVRDxRSTCTRL {
  /** Set this callback to handle software resets */
  onReset: (() => void) | null = null;

  constructor(cpu: CPU, base: number, ccp: AVRDxCCP) {
    // RSTFR - reset flags, write 1 to clear
    cpu.writeHooks[base + RSTFR] = (value) => {
      cpu.data[base + RSTFR] &= ~value;
      return true;
    };

    // SWRR - software reset register (CCP protected)
    cpu.writeHooks[base + SWRR] = (value) => {
      if (ccp.isUnlocked() && (value & SWRST_bm)) {
        if (this.onReset) this.onReset();
      }
      return true;
    };
  }
}

// AVR-Dx CLKCTRL peripheral
// Clock controller with CCP-protected writes.

import { type CPU } from 'avr8js/cpu/cpu';
import { type AVRDxCCP } from './avrdx-ccp';

const MCLKCTRLA  = 0x00;
const MCLKCTRLB  = 0x01;
const MCLKSTATUS = 0x02;
const OSCHFCTRLA = 0x08;

const PEN_bm     = 0x01;
const PDIV_gm    = 0x1E;
const SOSC_bm    = 0x01; // in MCLKSTATUS

export class AVRDxCLKCTRL {
  /** How many base clocks per instruction clock (1 = no prescaling, 4 = div4, etc.) */
  cycleMultiplier = 1;

  // PDIV field -> divisor lookup (AVR-Dx datasheet Table 11-1)
  private static readonly PDIV_DIVISORS: Record<number, number> = {
    0: 2, 1: 4, 2: 8, 3: 16, 4: 32, 5: 64,
    8: 6, 9: 10, 10: 12, 11: 24, 12: 48,
  };

  constructor(private cpu: CPU, private base: number, private ccp: AVRDxCCP) {
    // MCLKCTRLA - CCP protected
    cpu.writeHooks[base + MCLKCTRLA] = (value) => {
      if (this.ccp.isUnlocked()) {
        cpu.data[base + MCLKCTRLA] = value;
      }
      return true;
    };

    // MCLKCTRLB - CCP protected (prescaler)
    cpu.writeHooks[base + MCLKCTRLB] = (value) => {
      if (this.ccp.isUnlocked()) {
        cpu.data[base + MCLKCTRLB] = value;
        this.updatePrescaler();
        // Clear SOSC (System Oscillator Changing) flag immediately
        // (firmware busy-waits on this)
        cpu.data[base + MCLKSTATUS] &= ~SOSC_bm;
      }
      return true;
    };

    // MCLKSTATUS - read-only
    cpu.readHooks[base + MCLKSTATUS] = () => {
      // Always report stable (SOSC = 0)
      return cpu.data[base + MCLKSTATUS] & ~SOSC_bm;
    };
    cpu.writeHooks[base + MCLKSTATUS] = () => true; // ignore writes

    // OSCHFCTRLA - CCP protected
    cpu.writeHooks[base + OSCHFCTRLA] = (value) => {
      if (this.ccp.isUnlocked()) {
        cpu.data[base + OSCHFCTRLA] = value;
      }
      return true;
    };
  }

  private updatePrescaler() {
    const val = this.cpu.data[this.base + MCLKCTRLB];
    if (!(val & PEN_bm)) {
      this.cycleMultiplier = 1;
    } else {
      const pdiv = (val & PDIV_gm) >> 1;
      this.cycleMultiplier = AVRDxCLKCTRL.PDIV_DIVISORS[pdiv] ?? 2;
    }
  }
}

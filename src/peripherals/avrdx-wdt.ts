// AVR-Dx SLPCTRL - Sleep Controller
// Handles the SLEEP instruction by fast-forwarding to the next clock event.

import { type CPU } from 'avr8js/cpu/cpu';

// const CTRLA = 0;
// const STATUS = 1;

export class AVRDxWDT {
  constructor(cpu: CPU, base: number) {
    // firmware writes 0 to disable WDT. We need a write hook so it doesn't crash.
    // cpu.writeHooks[base + CTRLA] = (value) => {
    //   this.cpu.data[base + CTRLA] = value;
    //   return true;
    // };

    // cpu.writeHooks[base + STATUS] = (value) => {
    //   this.cpu.data[base + STATUS] = value;
    //   return true;
    // };
  }
}

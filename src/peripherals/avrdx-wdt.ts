// AVR-Dx SLPCTRL - Sleep Controller
// Handles the SLEEP instruction by fast-forwarding to the next clock event.

import type { CPU } from 'avr8js/cpu/cpu';

// const CTRLA = 0;
// const STATUS = 1;

export class AVRDxWDT {
  constructor(cpu: CPU, base: number) {
  }
}

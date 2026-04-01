// AVR-Dx SLPCTRL - Sleep Controller
// Handles the SLEEP instruction by fast-forwarding to the next clock event.

import type { CPU } from 'avr8js/cpu/cpu';

const CTRLA = 0;
const SEN_bm    = 0x01;
// const SMODE_gm  = 0x06;

export class AVRDxSLPCTRL {
  sleepUntil: number = 0;
  
  constructor(private cpu: CPU, private base: number) {
    // CTRLA - sleep mode + sleep enable
    cpu.writeHooks[base + CTRLA] = (value) => {
      cpu.data[base + CTRLA] = value;
      return true;
    };

    // Hook the SLEEP instruction
    cpu.onSleep = () => {
      this.handleSleep();
    };
  }

  private handleSleep() {
    const ctrla = this.cpu.data[this.base + CTRLA];
    if (!(ctrla & SEN_bm)) return; // sleep not enabled

    const nextEvent = (this.cpu as any).nextClockEvent;
    if (nextEvent) {
      this.sleepUntil = nextEvent.cycles;
    }
  }
}

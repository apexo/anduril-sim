// AVR-Dx SLPCTRL - Sleep Controller

import type { CPU } from 'avr8js/cpu/cpu';

const CTRLA = 0;
const SEN_bm    = 0x01;
const SMODE_gm  = 0x06;

export const SMODE_IDLE_gc = 0x00;
export const SMODE_STDBY_gc = 0x02;
export const SMODE_PDOWN_gc = 0x04;


export type SMODE = typeof SMODE_IDLE_gc | typeof SMODE_STDBY_gc | typeof SMODE_PDOWN_gc;
export type SleepCallback = (mode: SMODE) => void;

export class AVRDxSLPCTRL {
  sleepUntil: number = 0;
  sleeping: null | SMODE = null;
  callbacks: SleepCallback[];
  
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

    this.callbacks = [];
  }

  private handleSleep() {
    const ctrla = this.cpu.data[this.base + CTRLA];
    if (!(ctrla & SEN_bm)) return;

    const mode = ctrla & SMODE_gm;
    this.sleeping = mode as SMODE;

    const nextEvent = (this.cpu as any).nextClockEvent;
    if (nextEvent) {
      this.sleepUntil = nextEvent.cycles;
    }

    for (const cb of this.callbacks) {
      cb(mode as SMODE);
    }
  }

  onSleep(cb: SleepCallback) {
    this.callbacks.push(cb);
  }
}

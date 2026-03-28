// AVR-Dx RTC Periodic Interrupt Timer (PIT)
// Generates periodic interrupts from the 32768 Hz internal ULP oscillator.

import type { CPU, AVRInterruptConfig } from 'avr8js/cpu/cpu';

const FREQ_HZ = 32768;

const CTRLA    = 0x0;
const STATUS   = 0x1;
const INTCTRL  = 0x2;
const INTFLAGS = 0x3;

const PI_bm       = 0x01;
const PITEN_bm    = 0x01;
const PERIOD_gm   = 0x78; // bits [6:3]

// PIT period to number of 32768Hz clock cycles
// PERIOD field is bits [6:3] of CTRLA
export const PERIOD_CYCLES = [
  0,      // 0x00: OFF
  4,      // 0x01: CYC4
  8,      // 0x02: CYC8
  16,     // 0x03: CYC16
  32,     // 0x04: CYC32
  64,     // 0x05: CYC64
  128,    // 0x06: CYC128
  256,    // 0x07: CYC256
  512,    // 0x08: CYC512
  1024,   // 0x09: CYC1024
  2048,   // 0x0A: CYC2048
  4096,   // 0x0B: CYC4096
  8192,   // 0x0C: CYC8192
  16384,  // 0x0D: CYC16384
  32768,  // 0x0E: CYC32768
  0,
] as const;

export class AVRDxRTCPIT {
  private pitCallback: (() => void) | null = null;
  private irq: AVRInterruptConfig;
  tickCount = 0;

  constructor(private cpu: CPU, private base: number, irqNo: number, private cpuFreqHz: number) {
    this.irq = {
      address: irqNo * 2,
      flagRegister: base + INTFLAGS,
      flagMask: PI_bm,
      enableRegister: base + INTCTRL,
      enableMask: PI_bm,
    }
    
    // CTRLA - period select + enable
    cpu.writeHooks[base + CTRLA] = (value) => {
      cpu.data[base + CTRLA] = value;
      this.reconfigure();
      return true;
    };

    // STATUS - read-only busy flag (always report not busy for simplicity)
    // TODO: when should this report busy? do we need this?
    cpu.readHooks[base + STATUS] = () => 0;
    cpu.writeHooks[base + STATUS] = () => true; // ignore writes

    // INTCTRL - enable interrupt
    cpu.writeHooks[base + INTCTRL] = (value) => {
      cpu.data[base + INTCTRL] = value;
      if (value & PI_bm) {
        cpu.updateInterruptEnable(this.irq, value);
      }
      return true;
    };

    // INTFLAGS - write 1 to clear
    cpu.writeHooks[base + INTFLAGS] = (value) => {
      if (value & PI_bm) {
        cpu.data[base + INTFLAGS] &= ~PI_bm;
        cpu.clearInterrupt(this.irq);
      }
      return true;
    };
  }

  private get cycles() {
    const ctrla = this.cpu.data[this.base + CTRLA];
    if (!(ctrla & PITEN_bm)) return;
    return PERIOD_CYCLES[(ctrla & PERIOD_gm) >> 3] || undefined;
  }

  // effective tick frequency (Hz), null if disabled
  get frequency() {
    const c = this.cycles;
    return c ? FREQ_HZ / this.cycles : null;
  }

  private reconfigure() {
    if (this.pitCallback) {
      this.cpu.clearClockEvent(this.pitCallback);
      this.pitCallback = null;
    }

    const cycles = this.cycles;
    if (!cycles) return;

    this.scheduleTick(Math.round(cycles * this.cpuFreqHz / FREQ_HZ));
  }

  private scheduleTick(cycles: number) {
    this.pitCallback = this.cpu.addClockEvent(() => this.onTick(cycles), cycles);
  }

  private onTick(cycles: number) {
    this.tickCount++;
    this.pitCallback = null;

    this.cpu.setInterruptFlag(this.irq);

    // Re-schedule if still enabled
    if (this.cpu.data[this.base + CTRLA] & PITEN_bm) {
      this.scheduleTick(cycles);
    }
  }
}

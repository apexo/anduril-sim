// AVR-Dx DAC0 peripheral
// 10-bit DAC with output enable, used for LED brightness control on the D3AA

import type { CPU } from 'avr8js/cpu/cpu';

const CTRLA = 0x00;
// const DATA  = 0x02; // 16-bit (DATAL + DATAH)
const DATAL = 0x02;
const DATAH = 0x03;

const ENABLE_bm = 0x01;
const OUTEN_bm  = 0x40;

export class AVRDxDAC {
  constructor(private cpu: CPU, private base: number) {
  }

  /** Whether DAC is enabled and output is enabled */
  get enabled(): boolean {
    const ctrla = this.cpu.data[this.base + CTRLA];
    return !!(ctrla & ENABLE_bm) && !!(ctrla & OUTEN_bm);
  }

  /** Get the current 10-bit DAC value (0-1023).
   *  DAC0.DATA is left-aligned: the 10-bit value sits in bits [15:6]. */
  get value(): number {
    const raw16 = this.cpu.data[this.base + DATAL] | (this.cpu.data[this.base + DATAH] << 8);
    return raw16 >> 6;
  }
}

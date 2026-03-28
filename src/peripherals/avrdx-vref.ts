// AVR-Dx VREF peripheral
// Voltage reference selection for DAC0 and ADC0

import { CPU } from 'avr8js/cpu/cpu';

const ADC0REF = 0;
const DAC0REF = 2;

const VREF_VOLTAGES = [1.024, 2.048, 2.500, 4.096] as const;

export class AVRDxVREF {
  constructor(private cpu: CPU, private base: number) {
  }

  /** Get DAC Vref selection (raw register value) */
  get dacRef(): number {
    return this.cpu.data[this.base + DAC0REF] & 0x07;
  }

  get dacRefVolts(): number {
    return VREF_VOLTAGES[this.dacRef] ?? 0;
  }

  /** Get ADC Vref selection (raw register value) */
  get adcRef(): number {
    return this.cpu.data[this.base + ADC0REF] & 0x07;
  }

  get adcRefVolts(): number {
    return VREF_VOLTAGES[this.adcRef] ?? 0;
  }
}

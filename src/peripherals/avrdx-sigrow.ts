// AVR-Dx SIGROW - Signature Row
// Read-only factory calibration data. Pre-loaded with values that produce
// correct temperature readings with the D3AA firmware's conversion formula.

import { CPU } from 'avr8js/cpu/cpu';

// Typical AVR32DD20 calibration values.
// The firmware formula (from arch/avr32dd20.c mcu_temp_raw2cooked):
//   temp = (sigrow_offset << 4) - measurement
//   temp *= sigrow_slope
//   temp += 65536 / 8
//   temp >>= 10
//   result is Kelvin << 6
//
// IMPORTANT: On AVR, the (sigrow_offset << 4) shift is done in 16-bit
// arithmetic (int is 16-bit on AVR), so offset MUST be ≤ 0x0FFF (12-bit)
// or the shift overflows. The datasheet specifies TEMPSENSE1 as a 12-bit value.
//
// With slope=0x036F (879), offset=0x0800 (2048):
//   offset << 4 = 32768 (fits in 16 bits)
//   At 25°C: ADC_acc16 ≈ 10548, result = 19081 → 23°C (±2°C rounding)
//   At 80°C: ADC_acc16 ≈ 6447, result = 22601 → 78°C
//   Range -40°C..125°C: ADC values 3092..15394, all in valid 16-bit range
const DEFAULT_TEMPSENSE0 = 0x036F; // slope
const DEFAULT_TEMPSENSE1 = 0x0800; // offset (12-bit)

const TEMPSENSE0 = 0;
const TEMPSENSE1 = 2;

export class AVRDxSIGROW {
  constructor(cpu: CPU, base: number, readonly slope = DEFAULT_TEMPSENSE0, readonly offset = DEFAULT_TEMPSENSE1) {
    // TEMPSENSE0 (16-bit at 0x1104-0x1105)
    cpu.readHooks[base + TEMPSENSE0] = () => slope & 0xFF;
    cpu.readHooks[base + TEMPSENSE0 + 1] = () => (slope >> 8) & 0xFF;

    // TEMPSENSE1 (16-bit at 0x1106-0x1107)
    cpu.readHooks[base + TEMPSENSE1] = () => offset & 0xFF;
    cpu.readHooks[base + TEMPSENSE1 + 1] = () => (offset >> 8) & 0xFF;

    // Write hooks to prevent accidental writes
    cpu.writeHooks[base + TEMPSENSE0] = () => true;
    cpu.writeHooks[base + TEMPSENSE0 + 1] = () => true;
    cpu.writeHooks[base + TEMPSENSE1] = () => true;
    cpu.writeHooks[base + TEMPSENSE1 + 1] = () => true;
  }

  /** Compute the raw ADC result (16-bit accumulated) for a given temperature in Celsius */
  tempCToRawADC(tempC: number): number {
    const tempK = tempC + 273.15;
    const kelvin6 = Math.round(tempK * 64);
    // Reverse the firmware formula:
    // kelvin6 = ((offset << 4) - measurement) * slope + 8192) >> 10
    // kelvin6 << 10 = (offset << 4 - measurement) * slope + 8192
    // (kelvin6 << 10) - 8192 = (offset << 4 - measurement) * slope
    // measurement = (offset << 4) - ((kelvin6 << 10) - 8192) / slope
    const measurement = (this.offset << 4) - ((kelvin6 << 10) - 8192) / this.slope;
    return Math.max(0, Math.min(0xFFFF, Math.round(measurement)));
  }
}

// AVR-Dx ADC0 peripheral
// 12-bit ADC with accumulation, free-running mode, and multiple input sources.

import { type CPU, type AVRInterruptConfig } from 'avr8js/cpu/cpu';
import { type AVRDxVREF } from './avrdx-vref';

const CTRLA    = 0x0000;
const CTRLB    = 0x0001;
const CTRLC    = 0x0002;
// const CTRLD    = 0x0003;
// const CTRLE    = 0x0004;
// const SAMPCTRL = 0x0006;
const MUXPOS   = 0x0008;
// const MUXNEG   = 0x0009;
const COMMAND  = 0x000A;
// const EVCTRL   = 0x000B;
const INTCTRL  = 0x000C;
const INTFLAGS = 0x000D;
// const DBGCTRL  = 0x000E;
// const TEMP     = 0x000F;
const RESL     = 0x0010;
const RESH     = 0x0011;

// CTRLA bits
const ADC_ENABLE_bm               = 0x01;
const ADC_FREERUN_bm              = 0x02;
// const ADC_RESSEL_12BIT_gc         = 0x00;
// const ADC_RESSEL_10BIT_gc         = 0x04;
// const ADC_LEFTADJ_bm              = 0x10;
// const ADC_CONVMODE_SINGLEENDED_gc = 0x00;
// const ADC_RUNSTBY_bm              = 0x80;

// CTRLB accumulation
// const ADC_SAMPNUM_NONE_gc  = 0x00;
// const ADC_SAMPNUM_ACC2_gc  = 0x01;
// const ADC_SAMPNUM_ACC4_gc  = 0x02;
// const ADC_SAMPNUM_ACC8_gc  = 0x03;
// const ADC_SAMPNUM_ACC16_gc = 0x04;
// const ADC_SAMPNUM_ACC32_gc = 0x05;
// const ADC_SAMPNUM_ACC64_gc = 0x06;

// ADC0.COMMAND
const ADC_STCONV_bm = 0x01;

// ADC0.INTCTRL / INTFLAGS
const ADC_RESRDY_bm = 0x01;

// ADC MUXPOS special values
// const ADC_MUXPOS_AIN25_gc      = 0x19;  // PA5 battery voltage divider
// const ADC_MUXPOS_GND_gc        = 0x40;  // Ground
const ADC_MUXPOS_TEMPSENSE_gc  = 0x42;  // internal temperature sensor
// const ADC_MUXPOS_VDDDIV10_gc   = 0x44;  // VDD/10
// const ADC_MUXPOS_VDDIO2DIV10_gc = 0x45; // VDDIO2/10

// ADC prescaler (CTRLC)
// const ADC_PRESC_DIV2_gc  = 0x00;
// const ADC_PRESC_DIV4_gc  = 0x01;
// const ADC_PRESC_DIV8_gc  = 0x02;
// const ADC_PRESC_DIV16_gc = 0x03;
// const ADC_PRESC_DIV32_gc = 0x04;
// const ADC_PRESC_DIV64_gc = 0x05;
// const ADC_PRESC_DIV128_gc = 0x06;
// const ADC_PRESC_DIV256_gc = 0x07;


export class AVRDxADC {
  /** Voltage at the ADC pin in volts (after external voltage divider) */
  private voltagePinV = 0;
  /** Temperature: pre-computed raw accumulated ADC result (from SIGROW calibration) */
  private temperatureInput = 0;
  private conversionCallback: (() => void) | null = null;

  private readonly resrdyIrq: AVRInterruptConfig;

  constructor(private cpu: CPU, private base: number, resrdyIrqNo: number, private vref: AVRDxVREF) {
    this.resrdyIrq = {
      address: resrdyIrqNo * 2,  // vector 26, word addr 0x34
      flagRegister: base + INTFLAGS,
      flagMask: ADC_RESRDY_bm,
      enableRegister: base + INTCTRL,
      enableMask: ADC_RESRDY_bm,
    } as const;

    // COMMAND register - writing STCONV starts a conversion
    cpu.writeHooks[base + COMMAND] = (value) => {
      cpu.data[base + COMMAND] = value;
      if (value & ADC_STCONV_bm) {
        this.startConversion();
      }
      return true;
    };

    // INTCTRL
    cpu.writeHooks[base + INTCTRL] = (value) => {
      cpu.data[base + INTCTRL] = value;
      if (value & ADC_RESRDY_bm) {
        cpu.updateInterruptEnable(this.resrdyIrq, value);
      }
      return true;
    };

    // INTFLAGS - write 1 to clear
    cpu.writeHooks[base + INTFLAGS] = (value) => {
      cpu.data[base + INTFLAGS] &= ~value;
      if (value & ADC_RESRDY_bm) {
        cpu.clearInterrupt(this.resrdyIrq);
      }
      return true;
    };

    // RES registers - read only (but firmware can read them)
    cpu.writeHooks[base + RESL] = () => true; // ignore writes
    cpu.writeHooks[base + RESH] = () => true;
  }

  /** Set the voltage at the ADC pin (volts, after external divider).
   *  The ADC result is computed at conversion time from this voltage,
   *  the current VREF selection, and the accumulation count. */
  setVoltagePinV(volts: number) {
    this.voltagePinV = volts;
  }

  /** Set the raw ADC result for temperature (computed by runner with SIGROW values) */
  setRawTemperatureResult(raw16: number) {
    this.temperatureInput = raw16;
  }

  private startConversion() {
    const ctrla = this.cpu.data[this.base + CTRLA];
    if (!(ctrla & ADC_ENABLE_bm)) return;

    // Compute approximate conversion time
    // Prescaler from CTRLC
    const prescDiv = [2, 4, 8, 16, 32, 64, 128, 256][this.cpu.data[this.base + CTRLC] & 0x07];
    // Number of accumulated samples
    const sampNum = this.cpu.data[this.base + CTRLB] & 0x07;
    const numSamples = sampNum === 0 ? 1 : (1 << sampNum); // 1, 2, 4, 8, 16, 32, 64
    // Each conversion ~13 ADC clock cycles (plus init delay for first)
    const adcCycles = 15 * numSamples;
    const cpuCycles = adcCycles * prescDiv;

    // Schedule completion
    if (this.conversionCallback) {
      this.cpu.clearClockEvent(this.conversionCallback);
    }
    // TODO: do ADC CPU cycles depend on clock scaling? 
    this.conversionCallback = this.cpu.addClockEvent(() => this.completeConversion(), cpuCycles);
  }

  private completeConversion() {
    this.conversionCallback = null;

    const muxpos = this.cpu.data[this.base + MUXPOS];
    let result: number;

    if (muxpos === ADC_MUXPOS_TEMPSENSE_gc) {
      // Temperature: use pre-computed accumulated result from SIGROW calibration
      result = this.temperatureInput;
    } else {
      // External pin (voltage divider on AIN25, etc.):
      // Compute ADC result from physical pin voltage, current VREF, and accumulation
      const vref = this.vref.adcRefVolts;
      const sampNum = this.cpu.data[this.base + CTRLB] & 0x07;
      const numSamples = sampNum === 0 ? 1 : (1 << sampNum);
      const single = Math.min(4095, Math.max(0, Math.round(this.voltagePinV / vref * 4096)));
      result = single * numSamples;
    }

    // Clamp to 16-bit
    result = Math.max(0, Math.min(0xFFFF, Math.round(result)));

    // Write result
    this.cpu.data[this.base + RESL] = result & 0xFF;
    this.cpu.data[this.base + RESH] = (result >> 8) & 0xFF;

    // Clear STCONV
    this.cpu.data[this.base + COMMAND] &= ~ADC_STCONV_bm;

    // Set RESRDY flag and fire interrupt
    this.cpu.setInterruptFlag(this.resrdyIrq);

    // Free-running: start another conversion
    const ctrla = this.cpu.data[this.base + CTRLA];
    if (ctrla & ADC_FREERUN_bm) {
      this.startConversion();
    }
  }
}

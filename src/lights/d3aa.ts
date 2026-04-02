// D3AA Simulator
// Wires the avr8js CPU with AVR-Dx peripherals to simulate the D3AA flashlight.
 
// AVR32DD20 register addresses and interrupt vector definitions for the D3AA
// Sourced from arch/dfp/avrdd/include/avr/ioavr32dd20.h

import { CPU } from 'avr8js/cpu/cpu';
import { avrInstruction } from 'avr8js/cpu/instruction';

import { loadHex } from '../util';

import { AVRDxCCP } from '../peripherals/avrdx-ccp';
import { AVRDxPort } from '../peripherals/avrdx-port';
import { AVRDxDAC } from '../peripherals/avrdx-dac';
import { AVRDxVREF } from '../peripherals/avrdx-vref';
import { AVRDxADC } from '../peripherals/avrdx-adc';
import { AVRDxRTCPIT } from '../peripherals/avrdx-rtc-pit';
import { AVRDxCLKCTRL } from '../peripherals/avrdx-clkctrl';
import { AVRDxSLPCTRL } from '../peripherals/avrdx-slpctrl';
import { AVRDxRSTCTRL } from '../peripherals/avrdx-rstctrl';
import { AVRDxNVMCTRL } from '../peripherals/avrdx-nvmctrl';
import { AVRDxSIGROW } from '../peripherals/avrdx-sigrow';
import { AVRDxWDT } from '../peripherals/avrdx-wdt';

// In avr8js, data[0..31] are the CPU general-purpose registers R0-R31.
// On AVR-Dx, data addresses 0x0000-0x001F are VPORTs (R0-R31 aren't memory-mapped).
// This offset is added to all hardware data addresses so peripheral hooks
// and data storage don't collide with the register file.
const DATA_MEMORY_OFFSET = 32;

/*
 * memory layout
 * - 0x0000 - 0x13FF I/O
 * - 0x1400 - 0x14FF EEPROM
 * - 0x1500 - 0x6FFF unmapped(?)
 * - 0x7000 - 0x7FFF SRAM
 * - 0x8000 - 0xFFFF FLASH
 *
 * in the virtual CPU (cpu.data) everything is shifted by DATA_MEMORY_OFFSET
 * to accomodate the registers at data[0..31]; this should probably be
 * refactored, so that registers are not memory mapped by default and
 * are only hooked into memory for certain CPUs
 */

// const EEPROM_START = 0x1400 + DATA_MEMORY_OFFSET;
// const EEPROM_SIZE = 256;

const SRAM_START = 0x7000 + DATA_MEMORY_OFFSET;
const SRAM_SIZE = 0x1000;  // 4 KB

const MAPPED_PROGMEM_START = 0x8000 + DATA_MEMORY_OFFSET;
const FLASH_SIZE = 0x8000;  // 32 KB
const FLASH_WORDS = FLASH_SIZE / 2;

const CPU_DATA_SIZE = 0x10000 + DATA_MEMORY_OFFSET;

const CPU_FREQ = 12_000_000;  // 12 MHz default clock

// PORTA pins
const SWITCH_PIN     = 4;  // PA4 - e-switch
// const BATT_LVL_PIN   = 5;  // PA5 - battery voltage divider (AIN25)
const BST_ENABLE_PIN = 6;  // PA6 - boost regulator enable
const BUTTON_LED_PIN = 7;  // PA7 - button LED
const AUX_BLUE_PIN   = 0;  // PA0 - aux blue
const AUX_GREEN_PIN  = 2;  // PA2 - aux green
const AUX_RED_PIN    = 3;  // PA3 - aux red

// PORTD pins
const IN_NFET_PIN    = 4;  // PD4 - startup flash prevention
const HDR_PIN        = 5;  // PD5 - high/low current range
// const DAC_PIN        = 6;  // PD6 - DAC output

// PORTA_DIR_MASK = (1 << 0) | (1 << 2) | (1 << 3) | (1 << 6) | (1 << 7)
// PORTD_DIR_MASK = (1 << 4) | (1 << 5) | (1 << 6)

export interface D3AAState {
  level: number;       // brightness level 0-150 (estimated from DAC + VREF + HDR)
  dac: number;         // raw 10-bit DAC value (0-1023)
  vref: number;        // VREF index
  hdr: number;         // HDR FET on/off
  boost: number;       // boost enable on/off
  nfet: number;        // IN- NFET on/off
  auxR: number;        // aux red: 0=off, 1=low, 2=high
  auxG: number;        // aux green: 0=off, 1=low, 2=high
  auxB: number;        // aux blue: 0=off, 1=low, 2=high
  btnLed: number;      // button LED: 0=off, 1=low, 2=high
  voltage: number;     // battery voltage as vbat*50
  tempC: number;       // temperature in Celsius
  channel: number;     // (not directly readable from hardware, default 0)
  tickCount: number;   // PIT tick counter
  eeprom: Uint8Array;  // 256-byte EEPROM contents
  cycles: number;      // CPU cycle counter
}

export class D3AA {
  readonly cpu: CPU;
  readonly program: Uint16Array;

  // Peripherals
  readonly ccp: AVRDxCCP;
  readonly portA: AVRDxPort;
  readonly portC: AVRDxPort;
  readonly portD: AVRDxPort;
  readonly dac: AVRDxDAC;
  readonly vref: AVRDxVREF;
  readonly adc: AVRDxADC;
  readonly pit: AVRDxRTCPIT;
  readonly clkctrl: AVRDxCLKCTRL;
  readonly slpctrl: AVRDxSLPCTRL;
  readonly rstctrl: AVRDxRSTCTRL;
  readonly nvmctrl: AVRDxNVMCTRL;
  readonly sigrow: AVRDxSIGROW;
  readonly wdt: AVRDxWDT;

  // Simulation state
  private _voltage = 200;  // 4.0V default (vbat*50)
  private _tempC = 25;     // 25°C default

  constructor() {
    this.program = new Uint16Array(FLASH_WORDS);
    const sramBytes = CPU_DATA_SIZE - 0x100; // registerSpace = 0x100
    this.cpu = new CPU(this.program, sramBytes, { dataMemoryOffset: DATA_MEMORY_OFFSET, ioOffset: 0 });

    // Set SP to end of SRAM (not end of data array)
    this.cpu.SP = SRAM_START + SRAM_SIZE - 1; // 0x7FFF

    this.ccp = new AVRDxCCP(this.cpu, 0x0034 + DATA_MEMORY_OFFSET);
    this.rstctrl = new AVRDxRSTCTRL(this.cpu, 0x0040 + DATA_MEMORY_OFFSET, this.ccp);
    this.slpctrl = new AVRDxSLPCTRL(this.cpu, 0x0050 + DATA_MEMORY_OFFSET);
    this.clkctrl = new AVRDxCLKCTRL(this.cpu, 0x0060 + DATA_MEMORY_OFFSET, this.ccp);
    this.vref = new AVRDxVREF(this.cpu, 0x00B0 + DATA_MEMORY_OFFSET);
    this.wdt = new AVRDxWDT(this.cpu, 0x0100);
    this.pit = new AVRDxRTCPIT(this.cpu, 0x0150 + DATA_MEMORY_OFFSET, 6, CPU_FREQ);
    this.portA = new AVRDxPort(this.cpu, 0x0400 + DATA_MEMORY_OFFSET, 0x00 + DATA_MEMORY_OFFSET, 8);
    this.portC = new AVRDxPort(this.cpu, 0x0440 + DATA_MEMORY_OFFSET, 0x08 + DATA_MEMORY_OFFSET, 29);
    this.portD = new AVRDxPort(this.cpu, 0x0460 + DATA_MEMORY_OFFSET, 0x0C + DATA_MEMORY_OFFSET, 24);
    this.adc = new AVRDxADC(this.cpu, 0x0600 + DATA_MEMORY_OFFSET, 26, this.vref, this.slpctrl);
    this.dac = new AVRDxDAC(this.cpu, 0x06A0 + DATA_MEMORY_OFFSET);
    this.nvmctrl = new AVRDxNVMCTRL(this.cpu, 0x1000 + DATA_MEMORY_OFFSET, 0x1400 + DATA_MEMORY_OFFSET, 256, this.ccp);
    this.sigrow = new AVRDxSIGROW(this.cpu, 0x1104 + DATA_MEMORY_OFFSET);

    // Handle software reset: re-initialize everything
    this.rstctrl.onReset = () => {
      this.cpu.reset();
      this.cpu.SP = SRAM_START + SRAM_SIZE - 1;
    };

    // Set initial ADC values
    this.updateADCInputs();

    // Set switch pin high by default (button not pressed; active-low with pull-up)
    this.portA.setPin(SWITCH_PIN, true);
  }

  loadProgram(hex: string) {
    const u8 = new Uint8Array(this.program.buffer);
    loadHex(hex, u8);
    this.cpu.data.set(u8, MAPPED_PROGMEM_START);
  }

  loadEeprom(data: Uint8Array) {
    this.nvmctrl.loadEeprom(data);
  }

  getEepromSnapshot(): Uint8Array {
    return new Uint8Array(this.nvmctrl.eeprom);
  }

  /** Run the CPU for the given number of cycles */
  step(cycles: number) {
    const target = this.cpu.cycles + cycles;

    while (this.cpu.cycles < target) {
      this.cpu.tick();

      if (this.slpctrl.sleeping !== null) {
        const sleepUntil = (this.cpu as any).nextClockEvent?.cycles ?? Infinity;
        this.cpu.cycles = Math.min(target, sleepUntil);
        continue;
      }

      const before = this.cpu.cycles;
      avrInstruction(this.cpu);
      const mult = this.clkctrl.cycleMultiplier;
      if (mult > 1) {
        this.cpu.cycles += (this.cpu.cycles - before) * (mult - 1);
      }
    }
  }

  /** Simulate button press (e-switch goes low) */
  buttonPress() {
    this.portA.setPin(SWITCH_PIN, false);
  }

  /** Simulate button release (e-switch goes high) */
  buttonRelease() {
    this.portA.setPin(SWITCH_PIN, true);
  }

  /** Set battery voltage (as vbat * 50, e.g., 200 = 4.0V) */
  setVoltage(vbat50: number) {
    this._voltage = vbat50;
    this.updateADCInputs();
  }

  /** Set temperature in Celsius */
  setTemperature(tempC: number) {
    this._tempC = tempC;
    this.updateADCInputs();
  }

  /** Get current simulation state for the web UI */
  getState(): D3AAState {
    const portAOut = this.portA.outputValue;
    const portDOut = this.portD.outputValue;

    return {
      level: this.estimateLevel(),
      dac: this.dac.value,
      vref: this.vref.dacRef,
      hdr: (portDOut >> HDR_PIN) & 1,
      boost: (portAOut >> BST_ENABLE_PIN) & 1,
      nfet: (portDOut >> IN_NFET_PIN) & 1,
      auxR: this.getAuxState(this.portA, AUX_RED_PIN),
      auxG: this.getAuxState(this.portA, AUX_GREEN_PIN),
      auxB: this.getAuxState(this.portA, AUX_BLUE_PIN),
      btnLed: this.getAuxState(this.portA, BUTTON_LED_PIN),
      voltage: this._voltage,
      tempC: this._tempC,
      channel: 0,
      tickCount: this.pit.tickCount,
      eeprom: this.nvmctrl.eeprom,
      cycles: this.cpu.cycles,
    };
  }

  /** Detect 3-state aux LED: 0=off, 1=dim(pullup on input), 2=bright(output high) */
  private getAuxState(port: AVRDxPort, pin: number): number {
    const mask = 1 << pin;
    if (port.dirValue & mask) {
      // Output mode: high = bright, low = off
      return (port.outputValue & mask) ? 2 : 0;
    } else {
      // Input mode: check if pullup is enabled (dim mode)
      return port.isPullupEnabled(pin) ? 1 : 0;
    }
  }

  private updateADCInputs() {
    // Voltage: compute physical voltage at ADC pin after divider (330kΩ + 100kΩ)
    const vbat = this._voltage / 50;
    this.adc.setVoltagePinV(vbat * 100 / 430);

    // Temperature: use SIGROW calibration to compute raw ADC value
    this.adc.setRawTemperatureResult(this.sigrow.tempCToRawADC(this._tempC));
  }

  /** Estimate the Anduril ramp level from DAC + VREF + HDR state.
   *  This is approximate - the real mapping is defined by the PWM tables in the firmware. */
  private estimateLevel(): number {
    const dacVal = this.dac.value;
    const portDOut = this.portD.outputValue;
    const hdr = (portDOut >> HDR_PIN) & 1;
    const portAOut = this.portA.outputValue;
    const boost = (portAOut >> BST_ENABLE_PIN) & 1;

    if (!boost || dacVal === 0) return 0;

    const vref = this.vref.dacRefVolts;

    // Approximate level based on gear system:
    // Gear 1: Vref=1.024, HDR=0, levels 1-30
    // Gear 2: Vref=2.500, HDR=0, levels 31-40
    // Gear 3: Vref=1.024, HDR=1, levels 41-119
    // Gear 4: Vref=2.500, HDR=1, levels 120-150
    if (!hdr && vref < 2.0) {
      // Gear 1: DAC 3-954 → levels 1-30
      return Math.max(1, Math.min(30, Math.round(1 + (dacVal - 3) * 29 / 951)));
    } else if (!hdr && vref >= 2.0) {
      // Gear 2: DAC 434-1023 → levels 31-40
      return Math.max(31, Math.min(40, Math.round(31 + (dacVal - 434) * 9 / 589)));
    } else if (hdr && vref < 2.0) {
      // Gear 3: DAC 20-1018 → levels 41-119
      return Math.max(41, Math.min(119, Math.round(41 + (dacVal - 20) * 78 / 998)));
    } else {
      // Gear 4: DAC 430-1023 → levels 120-150
      return Math.max(120, Math.min(150, Math.round(120 + (dacVal - 430) * 30 / 593)));
    }
  }
}

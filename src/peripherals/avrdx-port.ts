// AVR-Dx VPORT + PORT GPIO peripheral
// Implements the dual VPORT (fast, 4 regs) + PORT (full, ~24 regs) model.

import type { CPU, AVRInterruptConfig } from 'avr8js/cpu/cpu';

// VPORT register offsets
const VPORT_DIR = 0x00;
const VPORT_OUT = 0x01;
const VPORT_IN  = 0x02;
const VPORT_INTFLAGS = 0x03;

// PORT register offsets from base
const DIR      = 0x00;
const DIRSET   = 0x01;
const DIRCLR   = 0x02;
const DIRTGL   = 0x03;
const OUT      = 0x04;
const OUTSET   = 0x05;
const OUTCLR   = 0x06;
const OUTTGL   = 0x07;
const IN       = 0x08;
const INTFLAGS = 0x09;
// const PORTCTRL = 0x0A;
const PIN0CTRL = 0x10;
// PIN1CTRL = 0x11, ..., PIN7CTRL = 0x17

// PINnCTRL bits
const PULLUPEN_bm          = 0x08;
const ISC_gm               = 0x07;
const ISC_INTDISABLE_gc    = 0x00;
const ISC_BOTHEDGES_gc     = 0x01;
const ISC_RISING_gc        = 0x02;
const ISC_FALLING_gc       = 0x03;
// const ISC_INPUT_DISABLE_gc = 0x04;
const ISC_LEVEL_gc         = 0x05;

export type PortListener = (dir: number, out: number) => void;

export class AVRDxPort {
  private pinState = 0x00; // external input state
  private listeners: PortListener[];
  private irq: AVRInterruptConfig;

  constructor(
    private cpu: CPU,
    private base: number,
    private vbase: number,
    irqNo: number,
  ) {
    this.listeners = [];
    
    this.irq = {
      address: irqNo * 2,
      flagRegister: vbase + VPORT_INTFLAGS,
      flagMask: 0xFF,
      enableRegister: base + PIN0CTRL, // dummy; we manage enable ourselves
      enableMask: 0,
      constant: true,  // don't auto-clear; firmware clears flags manually
    };

    cpu.writeHooks[vbase + VPORT_DIR] = (value) => {
      cpu.data[vbase + VPORT_DIR] = value;
      cpu.data[base + DIR] = value;
      return true;
    };

    cpu.writeHooks[vbase + VPORT_OUT] = (value) => {
      this.setOutput(value);
      return true;
    };

    // VPORT.IN - read returns pin state
    cpu.readHooks[vbase + VPORT_IN] = () => {
      return this.computeInputValue();
    };

    // VPORT.INTFLAGS - write 1 to clear
    cpu.writeHooks[vbase + VPORT_INTFLAGS] = (value) => {
      cpu.data[vbase + VPORT_INTFLAGS] &= ~value;
      cpu.data[base + INTFLAGS] &= ~value;
      // If all flags cleared, clear the interrupt
      if (cpu.data[vbase + VPORT_INTFLAGS] === 0) {
        cpu.clearInterrupt(this.irq);
      }
      return true;
    };

    // PORT.DIR
    cpu.writeHooks[base + DIR] = (value) => {
      cpu.data[base + DIR] = value;
      cpu.data[vbase + VPORT_DIR] = value;
      return true;
    };

    // PORT.DIRSET - write 1 to set bits in DIR
    cpu.writeHooks[base + DIRSET] = (value) => {
      const newDir = cpu.data[base + DIR] | value;
      cpu.data[base + DIR] = newDir;
      cpu.data[vbase + VPORT_DIR] = newDir;
      return true;
    };

    // PORT.DIRCLR - write 1 to clear bits in DIR
    cpu.writeHooks[base + DIRCLR] = (value) => {
      const newDir = cpu.data[base + DIR] & ~value;
      cpu.data[base + DIR] = newDir;
      cpu.data[vbase + VPORT_DIR] = newDir;
      return true;
    };

    // PORT.DIRTGL - write 1 to toggle bits in DIR
    cpu.writeHooks[base + DIRTGL] = (value) => {
      const newDir = cpu.data[base + DIR] ^ value;
      cpu.data[base + DIR] = newDir;
      cpu.data[vbase + VPORT_DIR] = newDir;
      return true;
    };

    cpu.writeHooks[base + OUT] = (value) => {
      this.setOutput(value);
      return true;
    };

    cpu.writeHooks[base + OUTSET] = (value) => {
      this.setOutput(cpu.data[base + OUT] | value);
      return true;
    };

    cpu.writeHooks[base + OUTCLR] = (value) => {
      this.setOutput(cpu.data[base + OUT] & ~value);
      return true;
    };

    cpu.writeHooks[base + OUTTGL] = (value) => {
      this.setOutput(cpu.data[base + OUT] ^ value);
      return true;
    };

    cpu.readHooks[base + IN] = () => {
      return this.computeInputValue();
    };

    // PORT.INTFLAGS - write 1 to clear (same as VPORT)
    cpu.writeHooks[base + INTFLAGS] = (value) => {
      cpu.data[base + INTFLAGS] &= ~value;
      cpu.data[vbase + VPORT_INTFLAGS] &= ~value;
      if (cpu.data[vbase + VPORT_INTFLAGS] === 0) {
        cpu.clearInterrupt(this.irq);
      }
      return true;
    };

    // PINnCTRL registers (0x10-0x17)
    for (let pin = 0; pin < 8; pin++) {
      cpu.writeHooks[base + PIN0CTRL + pin] = (value) => {
        cpu.data[base + PIN0CTRL + pin] = value;
        return true;
      };
    }
  }

  /** Set an external pin input value */
  setPin(pin: number, high: boolean) {
    const oldInput = this.computeInputValue();
    if (high) {
      this.pinState |= (1 << pin);
    } else {
      this.pinState &= ~(1 << pin);
    }
    const newInput = this.computeInputValue();
    this.checkInterrupts(oldInput, newInput);
  }

  /** Register a listener for output changes */
  addListener(listener: PortListener) {
    this.listeners.push(listener);
  }

  /** Get the current output register value */
  get outputValue(): number {
    return this.cpu.data[this.base + OUT];
  }

  /** Get the current direction register value */
  get dirValue(): number {
    return this.cpu.data[this.base + DIR];
  }

  isPullupEnabled(pin: number): boolean {
    if (pin < 0 || pin > 7) return false;
    return !!(this.cpu.data[this.base + PIN0CTRL + pin] & PULLUPEN_bm);
  }

  private setOutput(value: number) {
    const oldOut = this.cpu.data[this.base + OUT];
    this.cpu.data[this.base + OUT] = value;
    this.cpu.data[this.vbase + VPORT_OUT] = value;
    if (oldOut !== value) {
      const dir = this.cpu.data[this.base + DIR];
      for (const listener of this.listeners) {
        listener(dir, value);
      }
    }
  }

  /** Compute the IN register value: output pins reflect OUT, input pins reflect external state */
  private computeInputValue(): number {
    const dir = this.cpu.data[this.base + DIR];
    const out = this.cpu.data[this.base + OUT];
    // Output pins read back OUT value; input pins read external pin state
    return (dir & out) | (~dir & this.pinState);
  }

  private checkInterrupts(oldIn: number, newIn: number) {
    const changed = oldIn ^ newIn;
    if (!changed) return;

    let intFlags = 0;
    for (let pin = 0; pin < 8; pin++) {
      if (!(changed & (1 << pin))) continue;
      const isc = this.cpu.data[this.base + PIN0CTRL + pin] & ISC_gm;
      const wasHigh = !!(oldIn & (1 << pin));
      const isHigh = !!(newIn & (1 << pin));

      let fire = false;
      switch (isc) {
        case ISC_INTDISABLE_gc:
          break;
        case ISC_BOTHEDGES_gc:
          fire = true;
          break;
        case ISC_RISING_gc:
          fire = !wasHigh && isHigh;
          break;
        case ISC_FALLING_gc:
          fire = wasHigh && !isHigh;
          break;
        case ISC_LEVEL_gc:
          fire = !isHigh; // low level
          break;
      }
      if (fire) {
        intFlags |= (1 << pin);
      }
    }

    if (intFlags) {
      this.cpu.data[this.vbase + VPORT_INTFLAGS] |= intFlags;
      this.cpu.data[this.base + INTFLAGS] |= intFlags;
      this.cpu.queueInterrupt(this.irq);
    }
  }
}

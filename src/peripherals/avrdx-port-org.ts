// AVR-Dx VPORT + PORT GPIO peripheral
// Implements the dual VPORT (fast, 4 regs) + PORT (full, ~24 regs) model.

import { CPU, AVRInterruptConfig } from 'avr8js/dist/esm/cpu/cpu';
import {
  VPORT_DIR, VPORT_OUT, VPORT_IN, VPORT_INTFLAGS,
  PORT_DIR, PORT_DIRSET, PORT_DIRCLR, PORT_DIRTGL,
  PORT_OUT, PORT_OUTSET, PORT_OUTCLR, PORT_OUTTGL,
  PORT_IN, PORT_INTFLAGS, PORT_PIN0CTRL,
  PORT_ISC_gm, PORT_ISC_INTDISABLE_gc, PORT_ISC_BOTHEDGES_gc,
  PORT_ISC_RISING_gc, PORT_ISC_FALLING_gc, PORT_ISC_LEVEL_gc,
} from '../d3aa-config';

export interface AVRDxPortConfig {
  vportBase: number;
  portBase: number;
  interrupt: AVRInterruptConfig;
}

export type PortListener = (dir: number, out: number) => void;

export class AVRDxPort {
  private pinState = 0x00; // external input state
  private listeners: PortListener[] = [];

  constructor(
    private cpu: CPU,
    private config: AVRDxPortConfig,
  ) {
    const { vportBase: vb, portBase: pb } = config;

    cpu.writeHooks[vb + VPORT_DIR] = (value) => {
      cpu.data[vb + VPORT_DIR] = value;
      cpu.data[pb + PORT_DIR] = value;
      return true;
    };

    cpu.writeHooks[vb + VPORT_OUT] = (value) => {
      this.setOutput(value);
      return true;
    };

    cpu.readHooks[vb + VPORT_IN] = () => {
      return this.computeInputValue();
    };

    // VPORT.INTFLAGS - write 1 to clear
    cpu.writeHooks[vb + VPORT_INTFLAGS] = (value) => {
      cpu.data[vb + VPORT_INTFLAGS] &= ~value;
      cpu.data[pb + PORT_INTFLAGS] &= ~value;
      // If all flags cleared, clear the interrupt
      if (cpu.data[vb + VPORT_INTFLAGS] === 0) {
        cpu.clearInterrupt(config.interrupt);
      }
      return true;
    };

    cpu.writeHooks[pb + PORT_DIR] = (value) => {
      cpu.data[pb + PORT_DIR] = value;
      cpu.data[vb + VPORT_DIR] = value;
      return true;
    };

    // PORT.DIRSET - write 1 to set bits in DIR
    cpu.writeHooks[pb + PORT_DIRSET] = (value) => {
      const newDir = cpu.data[pb + PORT_DIR] | value;
      cpu.data[pb + PORT_DIR] = newDir;
      cpu.data[vb + VPORT_DIR] = newDir;
      return true;
    };

    // PORT.DIRCLR - write 1 to clear bits in DIR
    cpu.writeHooks[pb + PORT_DIRCLR] = (value) => {
      const newDir = cpu.data[pb + PORT_DIR] & ~value;
      cpu.data[pb + PORT_DIR] = newDir;
      cpu.data[vb + VPORT_DIR] = newDir;
      return true;
    };

    // PORT.DIRTGL - write 1 to toggle bits in DIR
    cpu.writeHooks[pb + PORT_DIRTGL] = (value) => {
      const newDir = cpu.data[pb + PORT_DIR] ^ value;
      cpu.data[pb + PORT_DIR] = newDir;
      cpu.data[vb + VPORT_DIR] = newDir;
      return true;
    };

    // PORT.OUT
    cpu.writeHooks[pb + PORT_OUT] = (value) => {
      this.setOutput(value);
      return true;
    };

    // PORT.OUTSET
    cpu.writeHooks[pb + PORT_OUTSET] = (value) => {
      this.setOutput(cpu.data[pb + PORT_OUT] | value);
      return true;
    };

    // PORT.OUTCLR
    cpu.writeHooks[pb + PORT_OUTCLR] = (value) => {
      this.setOutput(cpu.data[pb + PORT_OUT] & ~value);
      return true;
    };

    // PORT.OUTTGL
    cpu.writeHooks[pb + PORT_OUTTGL] = (value) => {
      this.setOutput(cpu.data[pb + PORT_OUT] ^ value);
      return true;
    };

    // PORT.IN - read returns pin state
    cpu.readHooks[pb + PORT_IN] = () => {
      return this.computeInputValue();
    };

    // PORT.INTFLAGS - write 1 to clear (same as VPORT)
    cpu.writeHooks[pb + PORT_INTFLAGS] = (value) => {
      cpu.data[pb + PORT_INTFLAGS] &= ~value;
      cpu.data[vb + VPORT_INTFLAGS] &= ~value;
      if (cpu.data[vb + VPORT_INTFLAGS] === 0) {
        cpu.clearInterrupt(config.interrupt);
      }
      return true;
    };

    // PINnCTRL registers (0x10-0x17)
    for (let pin = 0; pin < 8; pin++) {
      cpu.writeHooks[pb + PORT_PIN0CTRL + pin] = (value) => {
        cpu.data[pb + PORT_PIN0CTRL + pin] = value;
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
    return this.cpu.data[this.config.portBase + PORT_OUT];
  }

  /** Get the current direction register value */
  get dirValue(): number {
    return this.cpu.data[this.config.portBase + PORT_DIR];
  }

  private setOutput(value: number) {
    const { vportBase: vb, portBase: pb } = this.config;
    const oldOut = this.cpu.data[pb + PORT_OUT];
    this.cpu.data[pb + PORT_OUT] = value;
    this.cpu.data[vb + VPORT_OUT] = value;
    if (oldOut !== value) {
      const dir = this.cpu.data[pb + PORT_DIR];
      for (const listener of this.listeners) {
        listener(dir, value);
      }
    }
  }

  /** Compute the IN register value: output pins reflect OUT, input pins reflect external state */
  private computeInputValue(): number {
    const { portBase: pb } = this.config;
    const dir = this.cpu.data[pb + PORT_DIR];
    const out = this.cpu.data[pb + PORT_OUT];
    // Output pins read back OUT value; input pins read external pin state
    return (dir & out) | (~dir & this.pinState);
  }

  private checkInterrupts(oldIn: number, newIn: number) {
    const { portBase: pb, vportBase: vb } = this.config;
    const changed = oldIn ^ newIn;
    if (!changed) return;

    let intFlags = 0;
    for (let pin = 0; pin < 8; pin++) {
      if (!(changed & (1 << pin))) continue;
      const isc = this.cpu.data[pb + PORT_PIN0CTRL + pin] & PORT_ISC_gm;
      const wasHigh = !!(oldIn & (1 << pin));
      const isHigh = !!(newIn & (1 << pin));

      let fire = false;
      switch (isc) {
        case PORT_ISC_INTDISABLE_gc:
          break;
        case PORT_ISC_BOTHEDGES_gc:
          fire = true;
          break;
        case PORT_ISC_RISING_gc:
          fire = !wasHigh && isHigh;
          break;
        case PORT_ISC_FALLING_gc:
          fire = wasHigh && !isHigh;
          break;
        case PORT_ISC_LEVEL_gc:
          fire = !isHigh; // low level
          break;
      }
      if (fire) {
        intFlags |= (1 << pin);
      }
    }

    if (intFlags) {
      this.cpu.data[vb + VPORT_INTFLAGS] |= intFlags;
      this.cpu.data[pb + PORT_INTFLAGS] |= intFlags;
      // Directly queue the interrupt (bypassing the enable check, since
      // AVR-Dx port interrupts are enabled per-pin via PINnCTRL ISC bits,
      // not via a centralized enable register)
      this.cpu.queueInterrupt(this.config.interrupt);
    }
  }
}

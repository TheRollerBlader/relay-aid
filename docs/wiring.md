# Station wiring

No board, cable, or LED was attached while this repository was built. Do not treat the pin list below as a measured circuit.

If the station is an original Raspberry Pi Pico, the proposed mapping to verify against that board’s datasheet is:

| Signal | GPIO | Function |
|---|---|---|
| Cycle | GP14 | Button to ground, internal pull-up, selects WATER or CHARGING |
| Confirm | GP15 | Button to ground, internal pull-up, commits the selected need |
| Yellow | GP16 | Saved or delivered indicator, through its own resistor |
| Blue | GP17 | Acknowledged or assigned indicator, through its own resistor |
| Green | GP18 | Completed indicator, through its own resistor |

Datasheet to check before wiring: https://datasheets.raspberrypi.com/pico/pico-datasheet.pdf

With power disconnected, each button sits between its GPIO and ground. Each LED anode is fed from its GPIO through a resistor chosen from `R >= (V_GPIO - V_forward) / I_target`. Do not tie USB 5 V to a GPIO. A different board needs its own pinout. Firmware in `firmware/station/main.py` uses these GPIO numbers only for that proposed Pico mapping.

The host opens `SERIAL_DEVICE` only when that environment variable names an existing device path. It does not pick the first USB port. Frames are newline-delimited JSON, at most 256 bytes. A `PRESS` is saved in SQLite before the bridge replies `SAVED`.

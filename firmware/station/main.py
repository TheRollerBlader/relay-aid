"""USB station firmware for a Raspberry Pi Pico.

Proposed pins, unverified until the exact board is on the bench:
GP14 cycle (WATER / CHARGING), GP15 confirm, GP16 yellow, GP17 blue, GP18 green.
Buttons use internal pull-ups and read low when pressed. Each LED needs its own
series resistor. Do not copy these GPIO numbers onto a different board.
"""

from __future__ import annotations

import json
import sys

try:
    from logic import StationLogic
except ImportError:  # pragma: no cover - script directory on the device
    from firmware.station.logic import StationLogic  # type: ignore

FRAME_LIMIT = 256


def main() -> None:
    try:
        from machine import Pin
        import uselect
    except ImportError:
        print("RelayAid firmware needs MicroPython on the station board.", file=sys.stderr)
        return

    cycle = Pin(14, Pin.IN, Pin.PULL_UP)
    confirm = Pin(15, Pin.IN, Pin.PULL_UP)
    yellow = Pin(16, Pin.OUT)
    blue = Pin(17, Pin.OUT)
    green = Pin(18, Pin.OUT)
    logic = StationLogic()
    poll = uselect.poll()
    poll.register(sys.stdin, uselect.POLLIN)
    buffer = ""
    lights = {"yellow": yellow, "blue": blue, "green": green}
    for led in lights.values():
        led.value(0)
    _write({"v": 1, "type": "HELLO", **{k: v for k, v in logic.hello().items() if k != "v" and k != "type"}})

    while True:
        now = _ticks()
        pressed_cycle = cycle.value() == 0
        pressed_confirm = confirm.value() == 0
        frame = logic.sample(pressed_cycle, pressed_confirm, now)
        if frame and logic.pending and frame["pressSeq"] == logic.pending["pressSeq"]:
            # sample() also returns the pending frame; the bridge deduplicates on pressSeq.
            if not getattr(logic, "_sent_for", None) == frame["pressSeq"]:
                _write(frame)
                logic._sent_for = frame["pressSeq"]  # type: ignore[attr-defined]
        if poll.poll(0):
            char = sys.stdin.read(1)
            if char:
                buffer += char
                if len(buffer) > FRAME_LIMIT:
                    buffer = ""
                if "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    _handle(logic, lights, line)
        _pattern(lights, logic, now)


def _handle(logic: StationLogic, lights: dict, line: str) -> None:
    line = line.strip()
    if not line or len(line.encode()) > FRAME_LIMIT:
        return
    try:
        frame = json.loads(line)
    except ValueError:
        return
    if not isinstance(frame, dict):
        return
    logic.on_frame(frame)
    if frame.get("type") == "SAVED":
        logic._sent_for = None  # type: ignore[attr-defined]
    if frame.get("type") == "STATUS":
        logic._status = frame.get("state")  # type: ignore[attr-defined]


def _pattern(lights: dict, logic: StationLogic, now: int) -> None:
    status = getattr(logic, "_status", None)
    yellow = lights["yellow"]
    blue = lights["blue"]
    green = lights["green"]
    if logic.pending and status is None:
        yellow.value(1 if (now // 400) % 2 == 0 else 0)
        blue.value(0)
        green.value(0)
        return
    yellow.value(1 if status in {"DELIVERED", "NEW"} else 0)
    blue.value(1 if status in {"ACKNOWLEDGED", "ASSIGNED"} else 0)
    green.value(1 if status == "COMPLETED" else 0)
    if status is None and not logic.pending:
        yellow.value(0)


def _write(frame: dict) -> None:
    line = json.dumps(frame, separators=(",", ":"))
    if len(line.encode()) <= FRAME_LIMIT:
        sys.stdout.write(line + "\n")


def _ticks() -> int:
    try:
        from time import ticks_ms

        return int(ticks_ms())
    except ImportError:
        import time

        return int(time.monotonic() * 1000)


if __name__ == "__main__":
    main()

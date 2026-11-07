"""Station firmware state machine.

The Pico entrypoint in main.py wires GPIO and USB serial to this class.
Tests run the class without a board. Debounce is 50 ms. One unacknowledged
press stays in RAM and is repeated until SAVED. A reboot clears that RAM.
"""

from __future__ import annotations

DEBOUNCE_MS = 50


class StationLogic:
    def __init__(self) -> None:
        self.session_id: str | None = None
        self.selected = "WATER"
        self.pending: dict | None = None
        self._press_seq = 0
        self._cycle_held = False
        self._confirm_held = False
        self._cycle_since: int | None = None
        self._confirm_since: int | None = None
        self._cycle_latched = False
        self._confirm_latched = False

    def hello(self) -> dict:
        return {
            "v": 1,
            "type": "HELLO",
            "sessionId": self.session_id,
            "booted": self.session_id is None,
            "pendingPressSeq": None if self.pending is None else self.pending["pressSeq"],
        }

    def reboot(self) -> None:
        self.session_id = None
        self.pending = None
        self._press_seq = 0
        self.selected = "WATER"

    def on_frame(self, frame: dict) -> None:
        if frame.get("type") == "SESSION" and isinstance(frame.get("sessionId"), str):
            if self.session_id and frame["sessionId"] != self.session_id:
                self.pending = None
                self._press_seq = 0
            self.session_id = frame["sessionId"]
        if frame.get("type") == "SAVED" and self.pending and frame.get("pressSeq") == self.pending["pressSeq"]:
            self.pending = None

    def sample(self, cycle_down: bool, confirm_down: bool, now_ms: int) -> dict | None:
        self._arm(cycle_down, self._cycle_held, now_ms, "cycle")
        self._arm(confirm_down, self._confirm_held, now_ms, "confirm")
        self._cycle_held = cycle_down
        self._confirm_held = confirm_down
        if not cycle_down:
            self._cycle_latched = False
        if not confirm_down:
            self._confirm_latched = False
        if (
            cycle_down
            and self._cycle_since is not None
            and now_ms - self._cycle_since >= DEBOUNCE_MS
            and not self._cycle_latched
            and self.pending is None
        ):
            self._cycle_latched = True
            self.selected = "CHARGING" if self.selected == "WATER" else "WATER"
        if self.pending and self.session_id:
            return self._press()
        if not self.session_id or self.pending:
            return None
        if (
            confirm_down
            and self._confirm_since is not None
            and now_ms - self._confirm_since >= DEBOUNCE_MS
            and not self._confirm_latched
        ):
            self._confirm_latched = True
            self._press_seq += 1
            self.pending = {"pressSeq": self._press_seq, "need": self.selected}
            return self._press()
        return None

    def repeat(self) -> dict | None:
        if self.pending and self.session_id:
            return self._press()
        return None

    def _press(self) -> dict:
        return {
            "v": 1,
            "type": "PRESS",
            "sessionId": self.session_id,
            "pressSeq": self.pending["pressSeq"],
            "need": self.pending["need"],
        }

    def _arm(self, down: bool, was_down: bool, now_ms: int, which: str) -> None:
        since = "_cycle_since" if which == "cycle" else "_confirm_since"
        if down and not was_down:
            setattr(self, since, now_ms)
        if not down:
            setattr(self, since, None)

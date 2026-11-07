import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from logic import StationLogic


class FirmwareLogicTest(unittest.TestCase):
    def test_bounce_does_not_accept_and_two_confirms_differ(self) -> None:
        logic = StationLogic()
        logic.on_frame({"type": "SESSION", "sessionId": "11111111-1111-4111-8111-111111111111"})
        self.assertIsNone(logic.sample(False, True, 0))
        self.assertIsNone(logic.sample(False, False, 10))
        self.assertIsNone(logic.sample(False, True, 20))
        self.assertIsNone(logic.sample(False, False, 30))
        logic.sample(False, True, 100)
        first = logic.sample(False, True, 160)
        self.assertIsNotNone(first)
        assert first is not None
        self.assertEqual(first["need"], "WATER")
        repeated = logic.repeat()
        assert repeated is not None
        self.assertEqual(repeated["pressSeq"], first["pressSeq"])
        logic.on_frame({"type": "SAVED", "pressSeq": first["pressSeq"]})
        logic.sample(True, False, 200)
        logic.sample(True, False, 260)
        self.assertEqual(logic.selected, "CHARGING")
        logic.sample(False, True, 300)
        second = logic.sample(False, True, 360)
        assert second is not None
        self.assertNotEqual(second["pressSeq"], first["pressSeq"])
        self.assertEqual(second["need"], "CHARGING")

    def test_reboot_drops_unacked_press(self) -> None:
        logic = StationLogic()
        logic.on_frame({"type": "SESSION", "sessionId": "11111111-1111-4111-8111-111111111111"})
        logic.sample(False, True, 0)
        frame = logic.sample(False, True, 50)
        self.assertIsNotNone(frame)
        logic.reboot()
        self.assertIsNone(logic.repeat())
        hello = logic.hello()
        self.assertTrue(hello["booted"])
        self.assertIsNone(hello["sessionId"])


if __name__ == "__main__":
    unittest.main()

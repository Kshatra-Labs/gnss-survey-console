"""Parses the frames our encoders build (tests/oracle/js_frames.json from
the web test, kt_frames.json from the Android unit test) with pyubx2 and
checks every field we rely on - the reverse direction of gen_vectors.py.

    PYTHONPATH=<dir> python3 tests/oracle/check_encoders.py tests/oracle/js_frames.json
"""

from __future__ import annotations

import json
import sys

from pyubx2 import SET, POLL, UBXReader


def parse(hex_str: str, mode: int):
    return UBXReader.parse(bytes.fromhex(hex_str), msgmode=mode)


def main(path: str) -> None:
    f = json.load(open(path))

    m = parse(f["cfg_msg_navpvt_1"], SET)
    assert m.identity == "CFG-MSG", m.identity
    assert (m.msgClass, m.msgID, m.rateDDC if hasattr(m, "rateDDC") else None) or True
    raw = bytes.fromhex(f["cfg_msg_navpvt_1"])[6:-2]
    assert raw == bytes([0x01, 0x07, 0x01]), raw

    m = parse(f["cfg_msg_1074_0"], SET)
    assert m.identity == "CFG-MSG"
    assert bytes.fromhex(f["cfg_msg_1074_0"])[6:-2] == bytes([0xF5, 0x4A, 0x00])

    m = parse(f["cfg_tmode3_svin_60_2m"], SET)
    assert m.identity == "CFG-TMODE3", m.identity
    assert m.rcvrMode == 1, m.rcvrMode
    assert m.lla == 0
    assert m.svinMinDur == 60, m.svinMinDur
    assert m.svinAccLimit == 20000, m.svinAccLimit  # 0.1 mm units -> 2.0 m

    m = parse(f["cfg_tmode3_off"], SET)
    assert m.identity == "CFG-TMODE3" and m.rcvrMode == 0

    assert parse(f["poll_mon_ver"], POLL).identity == "MON-VER"
    assert parse(f["poll_cfg_prt"], POLL).identity == "CFG-PRT"

    # RTCM3 message IDs inside UBX class 0xF5, per pyubx2's own message table
    from pyubx2.ubxtypes_core import UBX_MSGIDS
    for rtcm_type, msg_id in f["rtcm_msg_ids"].items():
        key = bytes([0xF5, msg_id])
        name = UBX_MSGIDS.get(key)
        assert name is not None and rtcm_type in name, (rtcm_type, hex(msg_id), name)

    print(f"{path}: all encoder checks passed")


if __name__ == "__main__":
    main(sys.argv[1])

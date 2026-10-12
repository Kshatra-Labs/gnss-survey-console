"""Cross-checks the F9P simulator's output with pyubx2/pyrtcm, so the
end-to-end tests aren't validated by a simulator that shares the app's
assumptions.

    node tests/web/dump_sim.js > /tmp/sim.bin
    PYTHONPATH=<dir> python3 tests/web/check_sim.py /tmp/sim.bin
"""

from __future__ import annotations

import io
import sys

from pyrtcm.rtcmhelpers import calc_crc24q
from pyubx2 import NMEA_PROTOCOL, RTCM3_PROTOCOL, UBX_PROTOCOL, UBXReader


def main(path: str) -> None:
    data = open(path, "rb").read()
    rdr = UBXReader(io.BytesIO(data), protfilter=UBX_PROTOCOL | NMEA_PROTOCOL | RTCM3_PROTOCOL, quitonerror=0)
    pvts, svins, rtcm, acks, ver = [], [], [], 0, None
    for raw, msg in rdr:
        if msg is None:
            continue
        ident = getattr(msg, "identity", "")
        if ident == "NAV-PVT":
            pvts.append(msg)
        elif ident == "NAV-SVIN":
            svins.append(msg)
        elif ident == "MON-VER":
            ver = msg
        elif ident.startswith("ACK"):
            acks += 1

    # RTCM3: framing + pyrtcm's CRC-24Q. (pyubx2's reader silently drops MSM
    # frames whose random simulated bodies it can't decode, so walk directly.)
    i = 0
    while i < len(data):
        if data[i] == 0xD3 and i + 3 <= len(data) and (data[i + 1] & 0xFC) == 0:
            n = ((data[i + 1] & 3) << 8) | data[i + 2]
            f = data[i:i + n + 6]
            if len(f) == n + 6 and calc_crc24q(f) == 0:
                rtcm.append(int.from_bytes(f[3:5], "big") >> 4)
                i += n + 6
                continue
        i += 1

    assert pvts, "no NAV-PVT"
    carrs = [p.carrSoln for p in pvts]
    assert 0 in carrs and 2 in carrs, carrs           # starts uncorrected, reaches FIXED
    fixed = [p for p in pvts if p.carrSoln == 2]
    for p in fixed:
        assert p.fixType == 3 and p.gnssFixOk == 1 and p.diffSoln == 1, p
        assert abs(p.lat - 17.3850123) < 2e-7 and abs(p.lon - 78.4867456) < 2e-7, (p.lat, p.lon)
        assert abs(p.hMSL / 1000 - 540.1) < 0.02, p.hMSL
        assert abs(p.height / 1000 - (540.1 - 27.8)) < 0.02, p.height
        assert p.numSV == 24
    assert svins and svins[-1].valid == 1 and svins[-1].active == 0, svins[-1]
    assert any(p.fixType == 5 for p in pvts), "base never entered time mode"
    assert ver is not None and b"MOD=ZED-F9P" in ver.extension_04, ver
    assert acks >= 3
    assert {1005, 1074, 1084, 1094, 1124, 1230} <= set(rtcm), sorted(set(rtcm))
    print(f"simulator output verified by pyubx2/pyrtcm: {len(pvts)} NAV-PVT (carr {sorted(set(carrs))}), "
          f"{len(svins)} NAV-SVIN, {len(rtcm)} RTCM3 {sorted(set(rtcm))}, {acks} ACKs, MON-VER ok")


if __name__ == "__main__":
    main(sys.argv[1])

"""Generates protocol test vectors with pyubx2 / pyrtcm - independent
implementations of the u-blox UBX and RTCM3 specs - so the web (gnss.js)
and Android (Ubx.kt, Rtcm.kt) parsers are checked against a third party
rather than against frames they built themselves.

    pip install --target <dir> pyubx2 pyrtcm
    PYTHONPATH=<dir> python3 tests/oracle/gen_vectors.py > tests/oracle/vectors.json
"""

from __future__ import annotations

import json
import random
import sys

from pyrtcm.rtcmhelpers import calc_crc24q
from pyubx2 import UBXMessage, UBXReader

GET = 0


def nav_pvt(*, fix_type, carr, diff, fix_ok, num_sv, lat, lon, height_mm, hmsl_mm, hacc_mm, vacc_mm):
    msg = UBXMessage(
        "NAV", "NAV-PVT", GET,
        iTOW=123456, year=2026, month=10, day=12, hour=9, min=30, second=15,
        validDate=1, validTime=1, fullyResolved=1, tAcc=20, nano=-5000,
        fixType=fix_type, gnssFixOk=fix_ok, diffSoln=diff, psmState=0, headVehValid=0, carrSoln=carr,
        confirmedAvai=1, confirmedDate=1, confirmedTime=1,
        numSV=num_sv, lon=lon, lat=lat, height=height_mm, hMSL=hmsl_mm, hAcc=hacc_mm, vAcc=vacc_mm,
        velN=12, velE=-7, velD=3, gSpeed=14, headMot=0, sAcc=40, headAcc=0, pDOP=120,
    )
    return {
        "hex": msg.serialize().hex(),
        "expect": {
            "fixType": fix_type, "carrSoln": carr, "diffSoln": bool(diff), "gnssFixOk": bool(fix_ok),
            "numSv": num_sv, "latDeg": lat, "lonDeg": lon,
            "heightEllipsoidM": height_mm / 1000.0, "heightMslM": hmsl_mm / 1000.0,
            "hAccM": hacc_mm / 1000.0, "vAccM": vacc_mm / 1000.0,
        },
    }


def nav_svin(*, dur, mean_acc_01mm, obs, valid, active):
    msg = UBXMessage(
        "NAV", "NAV-SVIN", GET,
        version=0, iTOW=99000, dur=dur, meanX=123456789, meanY=-98765432, meanZ=55555555,
        meanXHP=3, meanYHP=-2, meanZHP=1, meanAcc=mean_acc_01mm, obs=obs, valid=valid, active=active,
    )
    return {
        "hex": msg.serialize().hex(),
        "expect": {"durationS": dur, "meanAccM": mean_acc_01mm / 10000.0, "observations": obs,
                   "valid": bool(valid), "active": bool(active)},
    }


def mon_ver():
    ext = [b"ROM BASE 0x118B2060", b"FWVER=HPG 1.32", b"PROTVER=27.31", b"MOD=ZED-F9P",
           b"GPS;GLO;GAL;BDS", b"SBAS;QZSS"]
    # pyubx2 can't build the variable extension group from kwargs (its
    # repeat count comes from the payload length), so lay the payload out
    # per spec - null-padded char[30] sw, char[10] hw, char[30] per
    # extension - and let pyubx2 frame it, then confirm it parses it back.
    raw = b"EXT CORE 1.00 (61b2dd)".ljust(30, b"\0") + b"00190000".ljust(10, b"\0")
    raw += b"".join(e.ljust(30, b"\0") for e in ext)
    msg = UBXMessage("MON", "MON-VER", GET, payload=raw)
    back = UBXReader.parse(msg.serialize())
    assert back.extension_02.rstrip(b"\0") == b"FWVER=HPG 1.32", back
    assert back.extension_04.rstrip(b"\0") == b"MOD=ZED-F9P", back
    return {
        "hex": msg.serialize().hex(),
        "expect": {"sw": "EXT CORE 1.00 (61b2dd)", "hw": "00190000", "mod": "ZED-F9P", "fw": "HPG 1.32",
                   "summary": "ZED-F9P HPG 1.32"},
    }


def rtcm_frame(msg_type: int, payload_len: int, rng: random.Random) -> bytes:
    payload = bytearray(rng.randrange(256) for _ in range(payload_len))
    payload[0] = (msg_type >> 4) & 0xFF
    payload[1] = ((msg_type & 0x0F) << 4) | (payload[1] & 0x0F)
    head = bytes([0xD3, (payload_len >> 8) & 0x03, payload_len & 0xFF]) + bytes(payload)
    return head + calc_crc24q(head).to_bytes(3, "big")


def main() -> None:
    rng = random.Random(20261012)
    out = {
        "nav_pvt": [
            nav_pvt(fix_type=3, carr=2, diff=1, fix_ok=1, num_sv=23, lat=17.3850123, lon=78.4867456,
                    height_mm=512345, hmsl_mm=540100, hacc_mm=14, vacc_mm=21),
            nav_pvt(fix_type=3, carr=1, diff=1, fix_ok=1, num_sv=19, lat=17.3851, lon=78.4869,
                    height_mm=511000, hmsl_mm=538800, hacc_mm=250, vacc_mm=410),
            nav_pvt(fix_type=3, carr=0, diff=0, fix_ok=1, num_sv=12, lat=-33.8688197, lon=-151.2092955,
                    height_mm=-12345, hmsl_mm=-30000, hacc_mm=1800, vacc_mm=2900),
            nav_pvt(fix_type=0, carr=0, diff=0, fix_ok=0, num_sv=0, lat=0.0, lon=0.0,
                    height_mm=0, hmsl_mm=0, hacc_mm=4294967, vacc_mm=3750000),
            nav_pvt(fix_type=5, carr=0, diff=0, fix_ok=1, num_sv=28, lat=51.4778, lon=-0.0015,
                    height_mm=45000, hmsl_mm=0, hacc_mm=1, vacc_mm=1),
        ],
        "nav_svin": [
            nav_svin(dur=42, mean_acc_01mm=35120, obs=42, valid=0, active=1),
            nav_svin(dur=97, mean_acc_01mm=19870, obs=97, valid=1, active=0),
        ],
        "mon_ver": [mon_ver()],
        "rtcm": [],
    }
    stream = bytearray()
    counts: dict[int, int] = {}
    for msg_type, plen in [(1005, 19), (1074, 120), (1084, 98), (1094, 140), (1124, 133), (1230, 6),
                           (1074, 1023), (4072, 30)]:
        f = rtcm_frame(msg_type, plen, rng)
        out["rtcm"].append({"hex": f.hex(), "type": msg_type})
        stream += b"$GNGGA,093015.00,1723.10074,N,07829.20473,E,4,23,0.6,540.1,M,-27.8,M,1.0,0000*4F\r\n"
        stream += bytes([0xD3, 0x00])  # truncated false preamble
        stream += f
        counts[msg_type] = counts.get(msg_type, 0) + 1
    corrupt = bytearray(rtcm_frame(1077, 50, rng))
    corrupt[20] ^= 0xFF
    stream += corrupt
    # trailing live traffic, so false preambles planted above can resolve
    stream += b"$GNGSA,A,3,01,02,03,04,05,06,07,08,09,10,11,12,0.9,0.6,0.7,1*00\r\n" * 20
    out["rtcm_stream"] = {"hex": stream.hex(), "counts": {str(k): v for k, v in counts.items()}}
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()

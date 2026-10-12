// Runs two simulated receivers through a full rover-then-base life cycle
// using raw UBX commands (no app code) and writes their combined output to
// stdout, for tests/web/check_sim.py to verify with pyubx2/pyrtcm.
"use strict";
const { F9pSim, ubxFrame } = require("./f9p_sim.js");

const out = [];
const rover = new F9pSim({ baud: 115200, epochMs: 20, noise: false, inProto: 0x23, seed: 3 });
const base = new F9pSim({ baud: 115200, epochMs: 20, noise: false, seed: 4 });
const cmd = (sim, cls, id, p) => sim.input(ubxFrame(cls, id, p));

rover.attach(115200, (b) => out.push(...b));
base.attach(115200, (b) => {
  out.push(...b);
  rover.input(b); // base output wired straight into the rover, like the relay
});
cmd(rover, 0x06, 0x01, [0x01, 0x07, 1]);
cmd(rover, 0x0a, 0x04, []);
cmd(base, 0x06, 0x01, [0x01, 0x07, 1]);
cmd(base, 0x06, 0x01, [0x01, 0x3b, 1]);
for (const id of [0x05, 0x4a, 0x54, 0x5e, 0x7c, 0xe6]) cmd(base, 0x06, 0x01, [0xf5, id, 1]);
const tmode = new Array(40).fill(0);
tmode[2] = 1; tmode[24] = 3; tmode[28] = 0x20; tmode[29] = 0x4e; // 3 s, 2.0 m
cmd(base, 0x06, 0x71, tmode);

setTimeout(() => {
  rover.detach();
  base.detach();
  process.stdout.write(Buffer.from(out));
}, 1500);

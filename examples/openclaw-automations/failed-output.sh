#!/bin/sh
# exceed the former local caps and exercise real native tail loss on the pinned host.
node --input-type=module -e '
import { writeSync } from "node:fs";
const block = Buffer.alloc(64 * 1024, "x");
for (const fd of [1, 2]) {
  for (let n = 0; n < 512; n++) writeSync(fd, block);
  writeSync(fd, "\n" + (fd === 1 ? "stdout-fixture-marker" : "stderr-fixture-marker") + "\n");
}
process.exitCode = 17;
'

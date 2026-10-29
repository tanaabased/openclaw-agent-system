#!/bin/sh
# exceed the former local caps without stress-testing native diagnostic redaction.
node --input-type=module -e '
import { writeFileSync, writeSync } from "node:fs";
writeFileSync("failed-output.started", "started\n");
const block = Buffer.alloc(64 * 1024, "x");
for (const fd of [1, 2]) {
  writeSync(fd, block);
  writeSync(fd, "\n" + (fd === 1 ? "stdout-fixture-marker" : "stderr-fixture-marker") + "\n");
}
writeFileSync("failed-output.finished", "output complete; intended exit 17\n");
process.exitCode = 17;
'

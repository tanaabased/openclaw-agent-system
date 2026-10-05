import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import termios
import time


for no_color, answer in ((False, b"\r"), (True, b"\r"), (False, b"\x03"), (True, b"\x03")):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 48, 0, 0))
    environment = dict(os.environ, CI="0", NONINTERACTIVE="0", FORCE_COLOR="3")
    environment.pop("NO_COLOR", None)
    if no_color:
        environment.pop("FORCE_COLOR", None)
        environment["NO_COLOR"] = "1"
    process = subprocess.Popen(
        ["openclaw", "agent-system", "install", "--json"],
        stdin=slave,
        stderr=slave,
        stdout=subprocess.PIPE,
        env=environment,
    )
    os.close(slave)
    output = bytearray()
    answered = False
    deadline = time.monotonic() + 60
    try:
        while process.poll() is None:
            assert time.monotonic() < deadline, "setup consent timed out"
            if not select.select([master], [], [], 0.1)[0]:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
            if not answered and b"Continue with installation?" in output:
                os.write(master, answer)
                answered = True
        assert process.wait(timeout=5) == 1, output.decode(errors="replace")
        assert answered, output.decode(errors="replace")
        assert process.stdout.read() == b"", "declined install must not emit a json result"
        text = output.decode(errors="replace")
        plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
        assert plain.index("setup-host:") < plain.index("setup-agent:")
        assert "brew-dependencies" in plain
        assert "agent-task" in plain
        assert "Continue with installation?" in plain
        assert "No" in plain
        if no_color:
            assert not re.search(r"\x1b\[[0-9;]*m", text), "NO_COLOR must disable styling"
        else:
            assert "\x1b[38;2;0;200;138msetup-host:" in text
            assert "\x1b[38;2;226;82;146msetup-agent:" in text
            assert "\x1b[1mbrew-dependencies\x1b[22m" in text
        assert not os.path.exists("consent-host-applied")
        assert not os.path.exists("consent-agent-applied")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        os.close(master)

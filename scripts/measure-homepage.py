#!/usr/bin/env python3
"""Measure the built homepage with an isolated daemon and a real shell/noise PTY."""
import errno
import fcntl
import json
import os
import pathlib
import pty
import selectors
import signal
import statistics
import struct
import subprocess
import tempfile
import termios
import time

REPO = pathlib.Path(__file__).resolve().parents[1]
NODE = '/opt/homebrew/bin/node'


def measure():
    with tempfile.TemporaryDirectory(prefix='ai-term-homepage-measure-') as root:
        env = {'PATH': '/usr/bin:/bin:/opt/homebrew/bin', 'HOME': root,
               'AI_TERM_HOME': root, 'SHELL': '/bin/sh', 'TERM': 'xterm-256color',
               'COLORTERM': 'truecolor', 'LANG': 'en_US.UTF-8'}
        entry = str(REPO / 'dist/cli/index.js')
        daemon = subprocess.Popen([NODE, entry, 'daemon'], cwd=REPO, env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 130, 0, 0))
        original = termios.tcgetattr(slave)
        client = None
        try:
            deadline = time.monotonic() + 5
            while not pathlib.Path(root, 'run/daemon.sock').exists():
                if time.monotonic() > deadline or daemon.poll() is not None:
                    raise RuntimeError('isolated daemon did not start')
                time.sleep(0.02)
            created = subprocess.run([NODE, entry, 'debug', 'shell', str(REPO)],
                                     cwd=REPO, env=env, text=True, capture_output=True,
                                     check=True, timeout=5)
            session_id = created.stdout.strip().split()[0]
            # Setup uses attach intentionally; the homepage itself never sends input.
            setup = subprocess.Popen([NODE, entry, 'debug', 'attach', session_id],
                                     cwd=REPO, env=env, stdin=slave, stdout=slave,
                                     stderr=subprocess.PIPE)
            os.set_blocking(master, False)
            selector = selectors.DefaultSelector()
            selector.register(master, selectors.EVENT_READ)
            output = bytearray()

            def drain(seconds):
                end = time.monotonic() + seconds
                while time.monotonic() < end:
                    for key, _ in selector.select(min(0.05, end - time.monotonic())):
                        try:
                            chunk = os.read(key.fd, 65536)
                            output.extend(chunk)
                        except OSError as error:
                            if error.errno not in (errno.EAGAIN, errno.EIO):
                                raise
            try:
                drain(0.4)
                command = NODE + ' spikes/renderer/noise.js\r'
                os.write(master, command.encode())
                drain(0.5)
                os.write(master, b'\x05')
                drain(0.3)
                setup.wait(timeout=5)
                if setup.returncode != 0:
                    raise RuntimeError('setup attach failed: ' + setup.stderr.read().decode())
            finally:
                if setup.poll() is None:
                    setup.terminate()
                    setup.wait(timeout=5)
                setup.stderr.close()
            output.clear()
            client = subprocess.Popen([NODE, entry], cwd=REPO, env=env,
                                      stdin=slave, stdout=slave, stderr=subprocess.PIPE)
            drain(1)
            if client.poll() is not None:
                raise RuntimeError('homepage failed: ' + client.stderr.read().decode())
            samples = []
            start = time.monotonic()
            initial_bytes = len(output)
            for _ in range(30):
                drain(1)
                sample = subprocess.run(['/bin/ps', '-o', '%cpu=', '-p', str(client.pid)],
                                        capture_output=True, text=True, check=True, timeout=3)
                samples.append(float(sample.stdout.strip()))
            duration = time.monotonic() - start
            steady_bytes = len(output) - initial_bytes
            os.write(master, b'/exit\r')
            drain(0.3)
            client.wait(timeout=5)
            restored = termios.tcgetattr(slave)
            result = {'seconds': duration, 'samples': samples,
                      'cpuAveragePercentOfOneCore': statistics.mean(samples),
                      'cpuMaxPercentOfOneCore': max(samples),
                      'stdoutBytesPerSecond': steady_bytes / duration,
                      'noiseVisible': b'NOISE' in output,
                      'syncFrames': output.count(b'\x1b[?2026h'),
                      'canonicalRestored': bool(restored[3] & termios.ICANON),
                      'signalsRestored': bool(restored[3] & termios.ISIG),
                      'initialCanonical': bool(original[3] & termios.ICANON),
                      'mouseOff': b'\x1b[?1006l' in output[-500:],
                      'alternateOff': b'\x1b[?1049l' in output[-500:],
                      'clientExitCode': client.returncode,
                      'node': subprocess.check_output([NODE, '--version'], text=True).strip()}
            print(json.dumps(result, indent=2))
            if result['cpuMaxPercentOfOneCore'] >= 15 or not result['noiseVisible']:
                raise RuntimeError('homepage performance/preview gate failed')
        finally:
            if client is not None:
                if client.poll() is None:
                    client.terminate()
                    client.wait(timeout=5)
                client.stderr.close()
            # Only our child daemon owns these PTYs; its normal shutdown stops them.
            daemon.send_signal(signal.SIGTERM) if daemon.poll() is None else None
            daemon.wait(timeout=10)
            daemon.stderr.close()
            os.close(master)
            os.close(slave)


if __name__ == '__main__':
    measure()

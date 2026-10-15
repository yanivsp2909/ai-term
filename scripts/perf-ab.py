#!/usr/bin/env python3
"""v0.9.3 performance A/B: two builds of AI Term measured back to back on this Mac, each with its own throwaway home
and daemon. Only the difference between them is gated, never an absolute number (the machine's load changes).

Usage: scripts/perf-ab.py <build A> <build B> [rounds]   (a build = a folder with dist/cli/index.js)
Per build and round:
  memory  - the daemon's RSS with 10 agents (shell sessions running spikes/renderer/noise.js, 33 writes/s each)
  redraw  - the homepage client's CPU (% of one core) and stdout bytes/s over 8 s with those 10 agents
  start   - cold `ai` start to the homepage's first full frame, daemon already running (median of 5)
  typing  - echo latency p95 of 150 keys typed into an 11th, quiet shell session through attach
"""
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
import sys
import tempfile
import termios
import time

REPO = pathlib.Path(__file__).resolve().parents[1]
NODE = '/opt/homebrew/bin/node'
AGENTS = 10
COLS, ROWS = 130, 45


class Pty:
    def __init__(self):
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
        os.set_blocking(self.master, False)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.master, selectors.EVENT_READ)
        self.output = bytearray()

    def drain(self, seconds, until=None):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            for key, _ in self.selector.select(max(0.0, min(0.02, end - time.monotonic()))):
                try:
                    self.output.extend(os.read(key.fd, 65536))
                except OSError as error:
                    if error.errno not in (errno.EAGAIN, errno.EIO):
                        raise
            if until is not None and until(self.output):
                return True
        return False

    def write(self, data):
        os.write(self.master, data)

    def close(self):
        os.close(self.master)
        os.close(self.slave)


def quit_homepage(client, term):
    # Keys one at a time, as typed; a client that doesn't leave in 3 s is stopped (the measurement is already taken).
    for key in [b'/', b'e', b'x', b'i', b't', b'\r']:
        term.write(key)
        term.drain(0.05)
    # Keep reading while it leaves: a client blocked on a full terminal can't exit.
    deadline = time.monotonic() + 3
    while client.poll() is None and time.monotonic() < deadline:
        term.drain(0.05)
    if client.poll() is None:
        client.terminate()
        while client.poll() is None:
            term.drain(0.05)
    term.close()


def run_build(build, rounds_out):
    entry = str(pathlib.Path(build) / 'dist/cli/index.js')
    with tempfile.TemporaryDirectory(prefix='ai-term-perf-') as root:
        env = {'PATH': '/usr/bin:/bin:/opt/homebrew/bin', 'HOME': root, 'AI_TERM_HOME': root, 'SHELL': '/bin/sh',
               'TERM': 'xterm-256color', 'COLORTERM': 'truecolor', 'LANG': 'en_US.UTF-8'}
        daemon = subprocess.Popen([NODE, entry, 'daemon'], cwd=build, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 10
            while not pathlib.Path(root, 'run/daemon.sock').exists():
                if time.monotonic() > deadline or daemon.poll() is not None:
                    raise RuntimeError('isolated daemon did not start')
                time.sleep(0.02)

            def shell():
                made = subprocess.run([NODE, entry, 'debug', 'shell', str(REPO)], cwd=build, env=env, text=True,
                                      capture_output=True, check=True, timeout=10)
                return made.stdout.strip().split()[0]

            def attach(session_id):
                term = Pty()
                proc = subprocess.Popen([NODE, entry, 'debug', 'attach', session_id], cwd=build, env=env,
                                        stdin=term.slave, stdout=term.slave, stderr=subprocess.DEVNULL)
                return term, proc

            def detach(term, proc):
                term.write(b'\x05')
                term.drain(0.3)
                try:
                    proc.wait(timeout=5)
                finally:
                    if proc.poll() is None:
                        proc.terminate()
                        proc.wait(timeout=5)
                    term.close()

            for _ in range(AGENTS):
                term, proc = attach(shell())
                term.drain(0.4)
                term.write((NODE + ' spikes/renderer/noise.js\r').encode())
                term.drain(0.3)
                detach(term, proc)
            time.sleep(3)

            rss = []
            for _ in range(5):
                rss.append(int(subprocess.check_output(['/bin/ps', '-o', 'rss=', '-p', str(daemon.pid)], text=True).strip()) / 1024)
                time.sleep(0.5)

            term = Pty()
            client = subprocess.Popen([NODE, entry], cwd=build, env=env, stdin=term.slave, stdout=term.slave, stderr=subprocess.DEVNULL)
            term.drain(2)
            cpu, start_bytes, started = [], len(term.output), time.monotonic()
            for _ in range(8):
                term.drain(1)
                cpu.append(float(subprocess.check_output(['/bin/ps', '-o', '%cpu=', '-p', str(client.pid)], text=True).strip()))
            bytes_per_second = (len(term.output) - start_bytes) / (time.monotonic() - started)
            quit_homepage(client, term)

            # The homepage's first complete frame: the end of a synchronized update that shows the command bar's agents.
            starts = []
            for _ in range(5):
                term = Pty()
                begun = time.monotonic()
                client = subprocess.Popen([NODE, entry], cwd=build, env=env, stdin=term.slave, stdout=term.slave, stderr=subprocess.DEVNULL)
                if not term.drain(10, until=lambda out: b'NOISE' in out and b'\x1b[?2026l' in out[out.find(b'NOISE'):]):
                    raise RuntimeError('homepage never drew')
                starts.append((time.monotonic() - begun) * 1000)
                quit_homepage(client, term)

            term, proc = attach(shell())
            term.drain(1)
            latencies = []
            for i in range(150):
                char = bytes([ord('a') + i % 26])
                term.output.clear()
                sent = time.monotonic()
                term.write(char)
                if term.drain(1, until=lambda out: char in out):
                    latencies.append((time.monotonic() - sent) * 1000)
                term.drain(0.015)
                if i % 25 == 24:
                    term.write(b'\x15')
                    term.drain(0.05)
            detach(term, proc)
            if len(latencies) < 140:
                raise RuntimeError(f'typing: only {len(latencies)} of 150 keys echoed')
            latencies.sort()
            rounds_out.append({
                'daemonRssMb': statistics.median(rss),
                'homepageCpuPercent': statistics.mean(cpu),
                'homepageBytesPerSecond': bytes_per_second,
                'coldStartMs': statistics.median(starts),
                'typingP50Ms': latencies[len(latencies) // 2],
                'typingP95Ms': latencies[int(len(latencies) * 0.95) - 1],
            })
        finally:
            if daemon.poll() is None:
                daemon.send_signal(signal.SIGTERM)
            daemon.wait(timeout=15)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    a, b = sys.argv[1], sys.argv[2]
    rounds = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    results = {'A': [], 'B': []}
    for _ in range(rounds):
        run_build(a, results['A'])
        run_build(b, results['B'])
    summary = {}
    for metric in results['A'][0]:
        median_a = statistics.median(r[metric] for r in results['A'])
        median_b = statistics.median(r[metric] for r in results['B'])
        summary[metric] = {'A': round(median_a, 2), 'B': round(median_b, 2),
                           'change%': round((median_b - median_a) / median_a * 100, 1) if median_a else None}
    print(json.dumps({'rounds': rounds, 'A': a, 'B': b, 'summary': summary, 'raw': results}, indent=2))


if __name__ == '__main__':
    main()

"""PTY-backed benchmark. Reads generated screen bytes, never private CLI state."""
import argparse
import json
import os
import pathlib
import pty
import selectors
import signal
import struct
import subprocess
import termios
import time
import fcntl

parser = argparse.ArgumentParser()
parser.add_argument('engine', choices=['ink', 'grid'])
parser.add_argument('--seconds', type=float, default=30)
parser.add_argument('--crash', action='store_true')
parser.add_argument('--cols', type=int, default=130)
parser.add_argument('--rows', type=int, default=45)
args = parser.parse_args()
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', args.rows, args.cols, 0, 0))
command = ['/opt/homebrew/bin/node', 'spikes/renderer/main.js', args.engine]
if args.crash:
    command.append('--crash')
started = time.monotonic()
child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=subprocess.PIPE,
                         env={'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'TERM': 'xterm-256color'},
                         start_new_session=True)
sel = selectors.DefaultSelector()
sel.register(master, selectors.EVENT_READ, 'screen')
sel.register(child.stderr, selectors.EVENT_READ, 'metrics')
ready = None
last_sample = started
last_key = started
cpu = []
stderr = bytearray()
screen = bytearray()
key_count = 0
resized = False
interrupted = False
frame_snapshot = None
try:
    while True:
        now = time.monotonic()
        for key, _ in sel.select(0.02):
            try:
                chunk = os.read(key.fd, 65536)
            except OSError:
                chunk = b''
            if not chunk:
                sel.unregister(key.fileobj)
                continue
            if key.data == 'metrics':
                stderr.extend(chunk)
                if ready is None and b'AITERM_READY ' in stderr:
                    ready = time.monotonic()
                    last_sample = ready
                    last_key = ready
            else:
                screen.extend(chunk)
        if ready is not None and not interrupted:
            elapsed = now - ready
            if now - last_sample >= 1:
                sample = subprocess.run(['/bin/ps', '-o', '%cpu=', '-p', str(child.pid)],
                                        capture_output=True, text=True, check=False)
                if sample.returncode == 0:
                    cpu.append(float(sample.stdout.strip()))
                last_sample = now
            if now - last_key >= 0.4:
                os.write(master, b'x' if key_count % 12 else b'\x7f')
                key_count += 1
                last_key = now
            if args.seconds < 30 and elapsed > args.seconds / 2 and not resized:
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 100, 0, 0))
                child.send_signal(signal.SIGWINCH)
                resized = True
            if elapsed >= args.seconds:
                frame_snapshot = bytes(screen)
                os.write(master, b'\x03')
                interrupted = True
        if child.poll() is not None:
            while True:
                chunk = child.stderr.read()
                if not chunk:
                    break
                stderr.extend(chunk)
            break
        if now - started > args.seconds + 15:
            raise TimeoutError('Prototype did not start/exit within watchdog')
    returncode = child.wait(timeout=3)
    # Parent retains slave for termios inspection, so EOF is not a drain boundary.
    os.set_blocking(master, False)
    while True:
        try:
            chunk = os.read(master, 65536)
        except BlockingIOError:
            break
        except OSError as error:
            if error.errno == 5:  # PTY hangup on platforms that signal EIO.
                break
            raise
        if not chunk:
            break
        screen.extend(chunk)
    raw = bool(termios.tcgetattr(slave)[3] & termios.ICANON) is False
    metrics = None
    for line in stderr.decode().splitlines():
        if line.startswith('AITERM_METRICS '):
            metrics = json.loads(line.split(' ', 1)[1])
    if metrics is None:
        raise RuntimeError(stderr.decode())
    result = {
        'command': ' '.join(command), 'seconds_requested': args.seconds,
        'terminal': [args.cols, args.rows], 'cpu_samples': cpu,
        'cpu_average': sum(cpu) / len(cpu) if cpu else None,
        'cpu_max': max(cpu) if cpu else None,
        'wall_startup_ms': (ready - started) * 1000 if ready else None,
        'input_samples_injected': key_count, 'exit_code': returncode,
        'resize_injected': resized, 'canonical_mode_restored': not raw,
        'cursor_restore_seen': b'\x1b[?25h' in screen[-300:],
        'alt_off_seen': b'\x1b[?1049l' in screen[-300:],
        'sync_off_seen': b'\x1b[?2026l' in screen[-300:],
        'metrics': metrics,
    }
    suffix = 'crash' if args.crash else ('smoke' if args.seconds < 30 else '30s')
    output = pathlib.Path(f'spikes/renderer/results-{args.engine}-{suffix}.json')
    output.write_text(json.dumps(result, indent=2) + '\n')
    pathlib.Path(f'spikes/renderer/screen-{args.engine}-{suffix}.ansi').write_bytes(frame_snapshot or screen)
    print(json.dumps(result, indent=2))
finally:
    if child.poll() is None:
        child.send_signal(signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    sel.close()
    child.stderr.close()
    os.close(master)
    os.close(slave)

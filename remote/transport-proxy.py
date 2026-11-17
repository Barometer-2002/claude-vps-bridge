"""Bounded byte forwarding for SSH; relay owns sessions, framing and replay."""
import errno
import os
from pathlib import Path
import re
import selectors
import socket
import subprocess
import sys
import time

LIMIT = 128 * 1024
CHUNK = 64 * 1024


def connect(root, identity):
    directory = root / 'run'
    directory.mkdir(mode=0o700, exist_ok=True)
    address = str(directory / (identity + '.sock'))

    def attempt():
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            client.connect(address)
            return client
        except BaseException:
            client.close()
            raise

    try:
        return attempt()
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ECONNREFUSED):
            raise
    # The existing kernel lock arbitrates concurrent launchers; never unlink a
    # socket or terminate another relay from this replaceable SSH process.
    node = (root / 'node-path').read_text().strip()
    log = os.open(directory / (identity + '.log'), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        if os.fstat(log).st_size > 64 * 1024:
            os.ftruncate(log, 0)
        child = subprocess.Popen(
            [sys.executable, str(root / 'relay-lock.py'), address + '.owner.lock',
             node, str(root / 'remote-transport.mjs'), identity],
            cwd=root, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            start_new_session=True, close_fds=True,
        )
    finally:
        os.close(log)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            return attempt()
        except OSError as error:
            if error.errno not in (errno.ENOENT, errno.ECONNREFUSED):
                raise
        child.poll()  # Reap a losing launcher; another owner may still be starting.
        time.sleep(0.1)
    raise RuntimeError('Remote relay failed to start')


def forward(client):
    """Each direction has a hard bound; EOF drains output and preserves half-close."""
    incoming, outgoing = bytearray(), bytearray()
    stdin_open = socket_open = True
    write_shutdown = False
    client.setblocking(False)
    old = {fd: os.get_blocking(fd) for fd in (0, 1)}
    try:
        for fd in old:
            os.set_blocking(fd, False)
        # poll also supports a redirected regular file, unlike epoll.
        with selectors.PollSelector() as poller:
            def watch(fd, events):
                try:
                    key = poller.get_key(fd)
                except KeyError:
                    key = None
                if events and key is None:
                    poller.register(fd, events)
                elif events and key.events != events:
                    poller.modify(fd, events)
                elif not events and key is not None:
                    poller.unregister(fd)

            while socket_open or outgoing:
                if socket_open and not stdin_open and not incoming and not write_shutdown:
                    client.shutdown(socket.SHUT_WR)
                    write_shutdown = True
                watch(0, selectors.EVENT_READ if stdin_open and socket_open and len(incoming) < LIMIT else 0)
                watch(1, selectors.EVENT_WRITE if outgoing else 0)
                watch(client, (selectors.EVENT_READ if socket_open and len(outgoing) < LIMIT else 0)
                      | (selectors.EVENT_WRITE if socket_open and incoming else 0))
                for key, events in poller.select():
                    try:
                        if key.fileobj == 0:
                            data = os.read(0, min(CHUNK, LIMIT - len(incoming)))
                            if data:
                                incoming.extend(data)
                            else:
                                stdin_open = False
                        elif key.fileobj == 1:
                            sent = os.write(1, outgoing)
                            del outgoing[:sent]
                        else:
                            if events & selectors.EVENT_WRITE and incoming:
                                sent = client.send(incoming)
                                del incoming[:sent]
                            if events & selectors.EVENT_READ:
                                data = client.recv(min(CHUNK, LIMIT - len(outgoing)))
                                if data:
                                    outgoing.extend(data)
                                else:
                                    socket_open = False
                    except BlockingIOError:
                        pass
    finally:
        for fd, blocking in old.items():
            os.set_blocking(fd, blocking)


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'[a-f0-9-]{36}', sys.argv[1]):
        raise ValueError('Invalid transport identity')
    root = Path(__file__).resolve().parent
    with connect(root, sys.argv[1]) as client:
        forward(client)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

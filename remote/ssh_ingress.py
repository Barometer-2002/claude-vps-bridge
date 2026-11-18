"""Classify this SSH connection using sshd's tuple and the current Linux network namespace."""
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import time


def address(text):
    value = ipaddress.ip_address(text)
    if getattr(value, 'scope_id', None):
        # /proc/net/tcp6 omits the zone. Ambiguous reverse tuples yield no name.
        value = ipaddress.ip_address(value.packed)
    return getattr(value, 'ipv4_mapped', None) or value


def port(text):
    if not re.fullmatch(r'[0-9]{1,5}', text) or not 0 < int(text) < 65536:
        raise ValueError('Invalid port')
    return int(text)


def endpoints(env):
    if env.get('SSH_CONNECTION'):
        peer, peer_port, server, server_port = env['SSH_CONNECTION'].split()
        return (address(peer), port(peer_port)), (address(server), port(server_port))
    peer, peer_port, server_port = env.get('SSH_CLIENT', '').split()
    return (address(peer), port(peer_port)), (None, port(server_port))


def local_addresses(proc, family):
    if family == 6:
        lines = (proc / 'net/if_inet6').read_text().splitlines()
        values = {ipaddress.IPv6Address(bytes.fromhex(line.split()[0])) for line in lines}
    else:
        # fib_trie includes secondary interface addresses and local host routes.
        table = (proc / 'net/fib_trie').read_text()
        values = {address(ip) for ip in re.findall(
            r'\|-- ([\d.]+)\s+\/32 host LOCAL\b', table)}
    if not values:
        raise ValueError('Local addresses unavailable')
    return values


def proc_endpoint(text):
    ip, encoded_port = text.split(':')
    # Linux prints each native-endian 32-bit word separately, including IPv6.
    raw = b''.join(int(ip[i:i + 8], 16).to_bytes(4, sys.byteorder)
                   for i in range(0, len(ip), 8))
    return address(str(ipaddress.ip_address(raw))), int(encoded_port, 16)


def sockets(proc):
    for name in ('tcp', 'tcp6'):
        try:
            lines = (proc / 'net' / name).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) > 9 and fields[3] == '01':
                yield proc_endpoint(fields[1]), proc_endpoint(fields[2]), fields[9]


def peer_inode(proc, peer, server):
    rows = [(local, remote, inode) for local, remote, inode in sockets(proc)
            if local == peer or remote == peer]
    if server[0] is None:
        # SSH_CLIENT omits the local address. Recover it only from a unique
        # matching accepted sshd socket before searching the reverse direction.
        possible = {local for local, remote, _ in rows if remote == peer and local[1] == server[1]}
        if len(possible) != 1:
            return None
        server = possible.pop()
    matches = {inode for local, remote, inode in rows if local == peer and remote == server}
    if len(matches) == 1:
        inode = matches.pop()
        if inode.isdecimal() and int(inode) > 0:
            return inode
    return None


def owner_name(proc, inode):
    if not inode:
        return None
    expected, names = 'socket:[' + inode + ']', set()
    deadline = time.monotonic() + 1
    for pid in proc.iterdir():
        if time.monotonic() > deadline:
            return None
        if not pid.name.isdecimal():
            continue
        try:
            for fd in (pid / 'fd').iterdir():
                if time.monotonic() > deadline:
                    return None
                try:
                    if os.readlink(fd) != expected:
                        continue
                    name = Path(os.readlink(pid / 'exe')).name
                    if os.readlink(fd) != expected or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_+-]{0,63}', name):
                        return None
                    names.add(name)
                    if len(names) > 1:
                        return None
                    break
                except FileNotFoundError:
                    continue  # Process or FD exited during enumeration.
        except OSError:
            continue
    return next(iter(names), None)


def observe(env=None, proc=Path('/proc')):
    result = {'kind': 'unknown', 'process': None}
    try:
        peer, server = endpoints(os.environ if env is None else env)
        if peer[0].is_unspecified or peer[0].is_multicast:
            return result
        is_local = peer[0].is_loopback or peer[0] == server[0]
        if is_local:
            result['kind'] = 'local-proxy'
        inode = peer_inode(proc, peer, server)
        if is_local or inode or peer[0] in local_addresses(proc, peer[0].version):
            result['kind'] = 'local-proxy'
            result['process'] = owner_name(proc, inode)
        else:
            result['kind'] = 'direct'
    except (OSError, ValueError, IndexError):
        pass
    return result


if __name__ == '__main__':
    print(json.dumps(observe()))

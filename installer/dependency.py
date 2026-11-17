"""Derive a managed adapter selection from the complete official npm tree."""
import hashlib
import json
from pathlib import Path
import re
import subprocess


def version_key(version):
    if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Invalid dependency version')
    return tuple(int(part) for part in version.split('.'))


def load_policy(text):
    """The policy names a release channel and a floor, not a frozen version."""
    policy = json.loads(text)
    if policy.get('schemaVersion') != 2 or policy.get('package') != '@codexhost/cli' or policy.get('track') != 'latest':
        raise ValueError('Invalid dependency policy')
    version_key(policy['minimumVersion'])
    return policy


def supported(version, policy):
    return version_key(version) >= version_key(policy['minimumVersion'])


def inspect_dependency(target, version, node, api_version=1):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Invalid dependency version')
    modules = Path(target) / 'node_modules' / '@codexhost'
    for name in ('cli', 'cli-linux-x64'):
        package = json.loads((modules / name / 'package.json').read_text(encoding='utf-8'))
        if package.get('name') != '@codexhost/' + name or package.get('version') != version:
            raise RuntimeError('Managed dependency package/version mismatch: ' + name)
    adapter = modules / 'cli-linux-x64/app/plugins/claude-code/plugin.mjs'
    manifest = json.loads(adapter.with_name('manifest.json').read_text(encoding='utf-8'))
    if manifest.get('adapterApiVersion') != api_version or manifest.get('entry') != adapter.name:
        raise RuntimeError('Managed adapter API or entry changed')
    subprocess.run([node, '--input-type=module', '-e',
                    'const m=await import(' + json.dumps(adapter.resolve().as_uri()) +
                    ');if(typeof m.createHarnessAdapter!=="function")throw Error("Adapter factory missing")'],
                   check=True, capture_output=True, timeout=30)
    return {'schemaVersion': 1, 'version': version, 'modulePath': str(adapter.resolve()),
            'sha256': hashlib.sha256(adapter.read_bytes()).hexdigest()}

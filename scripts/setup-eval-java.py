#!/usr/bin/env python3
"""Prepare pinned, verified evaluation dependencies and the explicit domain input fixture."""
import argparse
import hashlib
import json
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--jdk', type=pathlib.Path, required=True)
parser.add_argument('--out', type=pathlib.Path, default=root / '.eval-cache/java-deps')
args = parser.parse_args()
args.out = args.out.resolve()
args.out.mkdir(parents=True, exist_ok=True)
javac = args.jdk.resolve() / 'bin/javac'
jar = args.jdk.resolve() / 'bin/jar'
subprocess.run([str(javac), '-version'], check=True)
entries = json.loads((root / 'eval/java-dependencies.json').read_text())
for entry in entries:
    target = args.out / entry['url'].rsplit('/', 1)[1]
    if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != entry['sha256']:
        with tempfile.TemporaryDirectory(dir=args.out) as temp:
            download = pathlib.Path(temp) / 'artifact.jar'
            subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', '--output', str(download), entry['url']], check=True)
            if hashlib.sha256(download.read_bytes()).hexdigest() != entry['sha256']:
                raise RuntimeError(f'Artifact checksum mismatch: {target.name}')
            download.replace(target)
    print(f'Verified {target.name}')
with tempfile.TemporaryDirectory() as temp:
    classes = pathlib.Path(temp) / 'classes'
    classes.mkdir()
    subprocess.run([str(javac), '--release', '21', '-d', str(classes), str(root / 'eval/support/com/example/order/domain/Order.java')], check=True)
    fixture = pathlib.Path(temp) / 'poc-order-input.jar'
    subprocess.run([str(jar), '--create', '--file', str(fixture), '-C', str(classes), '.'], check=True)
    # Same filesystem is not assumed for temporary files.
    (args.out / fixture.name).write_bytes(fixture.read_bytes())
print(f'Classpath: {args.out}/*')

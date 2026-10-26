#!/usr/bin/env python3
"""Package with official vsce, then expose bundled guide PNGs as Marketplace assets.

No uploads or external hosting. Keep local Markdown relative for the offline guide;
vsce rewrites the storefront README to versioned HTTPS Marketplace asset URLs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import quote
import xml.etree.ElementTree as ET
from xml.sax.saxutils import quoteattr
import zipfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--vsce', help='Path to official @vscode/vsce/vsce entry point')
parser.add_argument('--out', help='Output VSIX; defaults to dist/commentink-<publisher>-<version>.vsix')
args = parser.parse_args()
manifest = json.loads((root / 'package.json').read_text())
publisher, name, version = (manifest[k] for k in ['publisher', 'name', 'version'])
source = (root / 'INSTALL.md').read_text()
images = sorted(set(re.findall(r'!\[[^\]]*\]\((docs/screenshots/[a-z0-9-]+\.png)\)', source)))
if not images:
    raise SystemExit('No guide screenshots found')
for image in images:
    data = (root / image).read_bytes()
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        raise SystemExit(f'Not a PNG: {image}')
(root / 'docs/USER-GUIDE.md').write_text(source.replace('](docs/screenshots/', '](screenshots/'))
base = f'https://{publisher}.gallery.vsassets.io/_apis/public/gallery/publisher/{publisher}/extension/{name}/{version}/assetbyname/'
output = Path(args.out).resolve() if args.out else root / 'dist' / f'commentink-{publisher}-{version}.vsix'
output.parent.mkdir(parents=True, exist_ok=True)
vsce = ['node', args.vsce] if args.vsce else ['npx', '--yes', '--package', '@vscode/vsce', 'vsce']
with tempfile.TemporaryDirectory(prefix='commentink-package-') as temporary:
    base_package = Path(temporary) / 'official.vsix'
    subprocess.run([*vsce, 'package', '--readme-path', 'INSTALL.md', '--allow-missing-repository',
                    '--baseImagesUrl', base, '--out', str(base_package)], cwd=root, check=True)
    with zipfile.ZipFile(base_package) as source_zip, zipfile.ZipFile(output, 'w') as target:
        for info in source_zip.infolist():
            data = source_zip.read(info.filename)
            if info.filename == 'extension.vsixmanifest':
                text = data.decode('utf-8')
                assets = '\n'.join(f'<Asset Type={quoteattr(p)} Path={quoteattr("extension/" + p)} Addressable="true" />' for p in images)
                if text.count('</Assets>') != 1:
                    raise SystemExit('Unexpected official VSIX asset manifest')
                data = text.replace('</Assets>', assets + '\n</Assets>').encode()
            target.writestr(info, data)
# Validate exactly what the user will upload, including the URL-to-asset mapping.
with zipfile.ZipFile(output) as package:
    metadata = json.loads(package.read('extension/package.json'))
    assert metadata['publisher'] == publisher and metadata['version'] == version
    xml = ET.fromstring(package.read('extension.vsixmanifest'))
    assets = {a.attrib['Type']: a.attrib for a in xml.findall('.//{*}Asset')}
    readme = package.read('extension/readme.md').decode()
    for image in images:
        assert assets[image]['Addressable'] == 'true'
        assert package.read(assets[image]['Path']) == (root / image).read_bytes()
        assert base + quote(image, safe='/') in readme
        assert package.read('extension/' + image) == (root / image).read_bytes()
    assert '](screenshots/' in package.read('extension/docs/USER-GUIDE.md').decode()
    assert not any('test-host.cjs' in p or p.endswith('.spec.cjs') or p.startswith('extension/scripts/') for p in package.namelist())
result = {'file': str(output), 'publisher': publisher, 'version': version,
          'bytes': output.stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
          'guideImages': images, 'marketplaceAssetBase': base,
          'verification': 'Bundled files, manifest mappings and HTTPS URLs validated; live CDN requires publication.',
          'references': ['https://github.com/microsoft/vscode-vsce/issues/17',
                         'https://learn.microsoft.com/en-us/azure/devops/extend/develop/static-content']}
(root / 'results-guide').mkdir(exist_ok=True)
(root / 'results-guide/package.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))

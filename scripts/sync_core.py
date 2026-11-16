#!/usr/bin/env python3
"""Install an explicit native-core build bundle into this plugin checkout."""
from pathlib import Path
import argparse,hashlib,json,shutil,os
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('bundle',type=Path);args=p.parse_args()
source=args.bundle.resolve();native=source/'native'
info=json.loads((source/'build-info.json').read_text()) if (source/'build-info.json').is_file() else None
if info:
    for name,sha in info['sha256'].items():
        rel=Path(name)
        if rel.is_absolute() or '..' in rel.parts:raise RuntimeError('Invalid build path')
        if hashlib.sha256((source/rel).read_bytes()).hexdigest()!=sha:raise RuntimeError('Build checksum mismatch')
for key in ['darwin-arm64','windows-amd64','linux-amd64']:
    bundle=native/key
    if not bundle.is_dir():continue
    files=json.loads((bundle/'manifest.json').read_text())
    for name,sha in files.items():
        rel=Path(name)
        if rel.is_absolute() or '..' in rel.parts:raise RuntimeError('Invalid bundle path')
        if hashlib.sha256((bundle/rel).read_bytes()).hexdigest()!=sha:raise RuntimeError('Bundle checksum mismatch')
    binary=source/('amcore.exe' if key.startswith('windows') else 'amcore')
    if not binary.is_file():raise RuntimeError('Missing core binary')
    target=ROOT/'bin'/('apple-music-core-'+key+('.exe' if key.startswith('windows') else ''))
    target.parent.mkdir(exist_ok=True);shutil.copy2(binary,target)
    if key.startswith('windows'):
        for dependency in source.glob('*.dll'):shutil.copy2(dependency,target.parent/dependency.name)
    if os.name!='nt':target.chmod(0o755)
    dest=ROOT/'bin/native'/key
    if dest.exists():shutil.rmtree(dest)
    shutil.copytree(bundle,dest)
    if not key.startswith('windows'):(dest/'native-helper').chmod(0o755)
    if key=='darwin-arm64':(dest/'AccountWindow.app/Contents/MacOS/account-ui').chmod(0o755)
    manifest={'protocol':1,'coreSHA256':hashlib.sha256(binary.read_bytes()).hexdigest(),'nativeFiles':files,'sourceCommit':info['commit'] if info else None}
    (ROOT/'bin'/('core-'+key+'.json')).write_text(json.dumps(manifest,indent=2)+'\n')
    if info:(ROOT/'bin'/('core-build-'+key+'.json')).write_text(json.dumps(info,indent=2)+'\n')
    print('Installed native core for '+key)
if (source/'licenses').is_dir():shutil.copytree(source/'licenses',ROOT/'bin/core-licenses',dirs_exist_ok=True)
archive=source/'corresponding-source.tar.gz';target=ROOT/'bin/core-source.tar.gz'
if archive.is_file() and (not target.exists() or (native/'darwin-arm64').is_dir()):shutil.copy2(archive,target)

#!/usr/bin/env python3
"""Fetch pinned public core archives; no account, SDK or extra token is needed."""
from pathlib import Path
import concurrent.futures, hashlib, json, re, stat, subprocess, urllib.request, zipfile

ROOT=Path(__file__).resolve().parents[1]

def main():
    lock=json.loads((ROOT/'core-lock.json').read_text())
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',lock['repository']): raise RuntimeError('Invalid core repository')
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+',lock['tag']): raise RuntimeError('Invalid core tag')
    output=ROOT/'build/core';output.mkdir(parents=True,exist_ok=True)
    def fetch(asset):
        name=asset['name']
        if Path(name).name!=name: raise RuntimeError('Invalid archive name')
        url=f"https://github.com/{lock['repository']}/releases/download/{lock['tag']}/{name}"
        request=urllib.request.Request(url,headers={'User-Agent':'mygo-core-build'})
        with urllib.request.urlopen(request,timeout=90) as response: data=response.read(asset['size']+1)
        if len(data)!=asset['size'] or hashlib.sha256(data).hexdigest()!=asset['sha256']: raise RuntimeError('Core release digest mismatch: '+name)
        archive=output/name;archive.write_bytes(data)
        destination=output/asset['platform'];destination.mkdir(exist_ok=True)
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                relative=Path(info.filename)
                if relative.is_absolute() or '..' in relative.parts or stat.S_IFMT(info.external_attr>>16)==stat.S_IFLNK: raise RuntimeError('Unsafe core archive path')
                target=destination/relative
                if info.is_dir():target.mkdir(parents=True,exist_ok=True);continue
                target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(z.read(info));target.chmod((info.external_attr>>16&0o777) or 0o644)
        bundle=destination/'apple-music-native-core';info=json.loads((bundle/'build-info.json').read_text())
        if info['commit']!=lock['commit'] or info['sourceDirty']: raise RuntimeError('Core source commit mismatch')
        return asset['platform'],bundle
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool: bundles=dict(pool.map(fetch,lock['assets']))
    for platform in ['darwin-arm64','windows-amd64','linux-amd64']:
        subprocess.run(['python3',str(ROOT/'scripts/sync_core.py'),str(bundles[platform]),'--expected-commit',lock['commit']],check=True)
    print('Installed exact core release '+lock['tag']+' at '+lock['commit'])

if __name__=='__main__':main()

#!/usr/bin/env python3
"""Install pinned core archives from a public release or the current test build."""
from pathlib import Path
import argparse, concurrent.futures, hashlib, json, re, stat, subprocess, urllib.request, zipfile

ROOT=Path(__file__).resolve().parents[1]
PLATFORMS=['darwin-arm64','windows-amd64','linux-amd64']
CORE_REPOSITORY='InkCitrus/apple-music-native-core'

def actions_lock(args):
    if not re.fullmatch(r'[0-9a-f]{40}',args.core_commit or '') or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',args.core_version or '') or not args.core_run or args.core_run <= 0:
        raise RuntimeError('An Actions build requires the core commit, version, and run ID')
    assets=[]
    for platform in PLATFORMS:
        folder=args.actions_bundles/f'amcore-release-{platform}'
        name=f'amcore-{args.core_version}-{platform}.zip'
        checksum=(folder/f'SHA256SUMS-{platform}.txt').read_text().splitlines()
        matches=[m[1] for line in checksum if (m:=re.fullmatch(r'([0-9a-f]{64})  '+re.escape(name),line))]
        if len(matches)!=1: raise RuntimeError('Expected one Actions checksum for '+name)
        assets.append({'name':name,'platform':platform,'size':(folder/name).stat().st_size,'sha256':matches[0]})
    return {'repository':CORE_REPOSITORY,'tag':None,'commit':args.core_commit,'actionsRun':args.core_run,'assets':assets}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--actions-bundles',type=Path)
    parser.add_argument('--core-commit')
    parser.add_argument('--core-version')
    parser.add_argument('--core-run',type=int)
    args=parser.parse_args()
    lock_path=ROOT/'core-lock.json'
    lock=actions_lock(args) if args.actions_bundles else json.loads(lock_path.read_text())
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',lock['repository']): raise RuntimeError('Invalid core repository')
    if not args.actions_bundles and not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+',lock['tag'] or ''): raise RuntimeError('Invalid core tag')
    output=ROOT/'build/core';output.mkdir(parents=True,exist_ok=True)
    def fetch(asset):
        name=asset['name']
        if Path(name).name!=name: raise RuntimeError('Invalid archive name')
        if args.actions_bundles:
            data=(args.actions_bundles/f"amcore-release-{asset['platform']}"/name).read_bytes()
        else:
            url=f"https://github.com/{lock['repository']}/releases/download/{lock['tag']}/{name}"
            request=urllib.request.Request(url,headers={'User-Agent':'mygo-core-build'})
            with urllib.request.urlopen(request,timeout=90) as response: data=response.read(asset['size']+1)
        if len(data)!=asset['size'] or hashlib.sha256(data).hexdigest()!=asset['sha256']: raise RuntimeError('Core archive digest mismatch: '+name)
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
    for platform in PLATFORMS:
        subprocess.run(['python3',str(ROOT/'scripts/sync_core.py'),str(bundles[platform]),'--expected-commit',lock['commit']],check=True)
    if args.actions_bundles:
        lock_path.write_text(json.dumps(lock,indent=2)+'\n')
    source=lock['tag'] or f"Actions run {lock['actionsRun']}"
    print('Installed exact core from '+source+' at '+lock['commit'])

if __name__=='__main__':main()

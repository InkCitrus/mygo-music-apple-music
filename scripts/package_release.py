#!/usr/bin/env python3
"""Package the reviewed JS and exact upstream core bytes in GitHub Actions."""
from pathlib import Path
import hashlib,json,os,stat,subprocess,zipfile

ROOT=Path(__file__).resolve().parents[1]
PLATFORMS=['darwin-arm64','windows-amd64','linux-amd64']
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
    manifest=json.loads((ROOT/'plugin.json').read_text());version=manifest['version'];lock=json.loads((ROOT/'core-lock.json').read_text())
    consistency=[]
    for platform in PLATFORMS:
        meta=json.loads((ROOT/'bin'/('core-'+platform+'.json')).read_text());build=json.loads((ROOT/'bin'/('core-build-'+platform+'.json')).read_text())
        if meta['sourceCommit']!=lock['commit'] or build['commit']!=lock['commit'] or build['sourceDirty'] or meta.get('localValidationOnly') or build.get('localValidationOnly'):
            raise RuntimeError('Core is not the pinned clean release')
        binary=ROOT/'bin'/('apple-music-core-'+platform+('.exe' if platform.startswith('windows') else ''))
        sourceName='amcore.exe' if platform.startswith('windows') else 'amcore'
        if digest(binary)!=meta['coreSHA256'] or meta['coreSHA256']!=build['sha256'][sourceName]:raise RuntimeError('Core binary differs from upstream')
        for name,sha in meta['nativeFiles'].items():
            if digest(ROOT/'bin/native'/platform/name)!=sha or sha!=build['sha256']['native/'+platform+'/'+name]:raise RuntimeError('Native resources differ from upstream')
        manifestName='native/'+platform+'/manifest.json'
        if digest(ROOT/'bin'/manifestName)!=build['sha256'][manifestName]:raise RuntimeError('Native manifest differs from upstream')
        for name,sha in build['sha256'].items():
            if '/' not in name and name.endswith('.dll') and digest(ROOT/'bin'/name)!=sha:raise RuntimeError('Runtime dependency differs from upstream')
        consistency.append({'platform':platform,'coreSourceCommit':lock['commit'],'coreSHA256':meta['coreSHA256'],'matchesUpstreamBuild':True,'nativeResourcesMatch':True,'runtimeDependenciesMatch':True})
    output=ROOT/'build/release';output.mkdir(parents=True,exist_ok=True);archives=[]
    for platform in PLATFORMS+[None]:
        target=output/f'mygo-music-apple-music-{version}-{platform or "all"}.zip'
        files=[ROOT/name for name in ['plugin.json','core-lock.json','LICENSE','README.md','README.zh-CN.md','CHANGELOG.md']]
        files += [p for folder in ['dist','locales','bin'] for p in sorted((ROOT/folder).rglob('*')) if p.is_file()]
        with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
            for path in files:
                relative=path.relative_to(ROOT)
                if path.is_symlink():raise RuntimeError('Unexpected link in plugin')
                if platform and relative.parts[0]=='bin':
                    if any(other in relative.as_posix() for other in PLATFORMS if other!=platform):continue
                    if platform!='windows-amd64' and path.parent==ROOT/'bin' and path.suffix.lower()=='.dll':continue
                info=zipfile.ZipInfo.from_file(path,'mygo-music-apple-music/'+relative.as_posix())
                executable=path.name.startswith('apple-music-core-') or path.name in {'native-helper','native-helper.exe','account-ui'}
                info.external_attr=(stat.S_IFREG|(0o755 if executable else 0o644))<<16
                z.writestr(info,path.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
        with zipfile.ZipFile(target) as z:
            if z.testzip() is not None:raise RuntimeError('Plugin archive integrity failed')
        archives.append(target)
    (output/'SHA256SUMS.txt').write_text(''.join(digest(p)+'  '+p.name+'\n' for p in archives))
    revision=subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip()
    report={'pluginVersion':version,'pluginCommit':revision,'coreTag':lock['tag'],'coreCommit':lock['commit'],'coreActionsRun':lock['actionsRun'],'platforms':consistency,
            'builtInGitHubActions':os.environ.get('GITHUB_ACTIONS')=='true',
            'packages':[{ 'name':p.name,'sha256':digest(p),'size':p.stat().st_size } for p in archives]}
    (output/'build-validation.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))

if __name__=='__main__':main()

"""Materialize only explicitly selected images/PDFs/video frames for native Claude Read."""
import base64, hashlib, json, os, re, uuid
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from bridge_paths import WORKSPACE_ROOT

LIMIT=5*1024*1024
EXTENSIONS=('.png','.jpg','.jpeg','.webp','.gif','.pdf')

class CacheMiss(ValueError):
    pass

def cache_root():
    session=os.environ.get('WINDOWS_MEDIA_SESSION') or os.environ.get('WINDOWS_BRIDGE_SESSION','')
    if not session or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in session):
        raise ValueError('Missing bridge session for attachment')
    root=(WORKSPACE_ROOT/'.bridge-media')/session
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    return root

def read_cached(target):
    if target.is_symlink():raise CacheMiss('Attachment cache entry is not a regular owned file')
    try:
        with target.open('rb') as stream:raw=stream.read(LIMIT+1)
    except FileNotFoundError as error:raise CacheMiss('Attachment cache entry is missing') from error
    if len(raw)>LIMIT:raise CacheMiss('Attachment cache entry exceeds its bound')
    return raw

def reference_file(root,key):
    return root/('.source-'+hashlib.sha256(str(key).encode()).hexdigest()+'.ref')

def known_hashes(key):
    root=cache_root()
    try:
        with reference_file(root,key).open() as stream:name=stream.read(128)
        if not re.fullmatch(r'[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif|pdf)',name):return []
        target=root/name
        if target.is_symlink() or not target.is_file() or target.stat().st_size>LIMIT:return []
        return [name.split('.')[0]]
    except OSError:return []

def materialize(payload,key=None):
    root=cache_root();files=[]
    for item in payload['files']:
        if not isinstance(item.get('sha256'),str) or not re.fullmatch(r'[a-f0-9]{64}',item['sha256']):
            raise ValueError('Invalid attachment hash')
        ext=item['extension']
        if ext not in EXTENSIONS:
            raise ValueError('Unsupported attachment type')
        target=root/(item['sha256']+ext)
        if item.get('cached') is True:
            raw=read_cached(target)
            if hashlib.sha256(raw).hexdigest()!=item['sha256'] or item.get('bytes')!=len(raw):
                raise CacheMiss('Attachment cache identity mismatch')
        else:
            encoded=item.get('base64')
            if not isinstance(encoded,str) or len(encoded)>((LIMIT+2)//3)*4:raise ValueError('Attachment size limit exceeded')
            raw=base64.b64decode(encoded,validate=True)
            if len(raw)>LIMIT or hashlib.sha256(raw).hexdigest()!=item['sha256']:
                raise ValueError('Attachment size/hash mismatch')
            if target.is_symlink():raise ValueError('Attachment cache entry is not a regular owned file')
            try:matches=hashlib.sha256(read_cached(target)).hexdigest()==item['sha256']
            except CacheMiss:matches=False
            if not matches:
                temporary=root/(target.name+'.'+uuid.uuid4().hex+'.tmp')
                try:
                    with temporary.open('xb') as stream:stream.write(raw)
                    temporary.chmod(0o600);os.replace(temporary,target)
                finally:temporary.unlink(missing_ok=True)
        files.append({'path':str(target),'sha256':item['sha256'],'bytes':len(raw),**({'timestamp':item['timestamp']} if 'timestamp' in item else {})})
    if key is not None and len(files)==1:
        reference=reference_file(root,key);temporary=reference.with_name(reference.name+'.'+uuid.uuid4().hex+'.tmp')
        try:
            temporary.write_text(Path(files[0]['path']).name);temporary.chmod(0o600);os.replace(temporary,reference)
        finally:temporary.unlink(missing_ok=True)
    return {'source':payload['source'],'kind':payload['kind'],'files':files,**({'bytes':payload['bytes']} if 'bytes' in payload else {}),'note':payload.get('note','Read these cached attachments using native Read. Original files remain on Windows.')}

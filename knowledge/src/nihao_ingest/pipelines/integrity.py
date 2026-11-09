"""SHA256 content verification, explicitly restored by the current user request."""
from __future__ import annotations
import hashlib
from pathlib import Path


def file_sha256(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''): digest.update(block)
    return digest.hexdigest()


def text_sha256(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def verify_file(path, expected=None):
    actual=file_sha256(path)
    if expected and actual!=expected: raise ValueError('SHA256 mismatch: '+str(path))
    return actual

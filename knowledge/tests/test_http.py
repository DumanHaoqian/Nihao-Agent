import json
from pathlib import Path
import pytest
import requests
from nihao_ingest.http import HttpClient, FetchError
from nihao_ingest.core import stable_id

class Response:
    def __init__(self, status=200, body=b'hello', headers=None, chunks=None):
        self.status_code = status
        self.headers = headers or {}
        self.body = body
        self.chunks = chunks
        self.closed = False
    def iter_content(self, _size):
        for item in self.chunks if self.chunks is not None else [self.body]:
            if isinstance(item, Exception):
                raise item
            yield item
    def close(self):
        self.closed = True

class Session:
    def __init__(self, *responses):
        self.headers = {}
        self.responses = list(responses)
        self.calls = []
    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if not self.responses:
            raise AssertionError('Unexpected network request: ' + url)
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

@pytest.fixture
def client_factory(tmp_path, monkeypatch):
    monkeypatch.setattr('nihao_ingest.http.time.sleep', lambda _t: None)
    def make(*responses, **kwargs):
        session = Session(*responses)
        client = HttpClient(tmp_path, contact='offline-test@example.org', delay=0, session=session, **kwargs)
        return client, session
    return make

def test_missing_contact_fails_without_network(tmp_path, monkeypatch):
    monkeypatch.delenv('NIHAO_CONTACT', raising=False)
    with pytest.raises(FetchError, match='NIHAO_CONTACT'):
        HttpClient(tmp_path)

def test_robots_denial_blocks_content(client_factory):
    client, session = client_factory(Response(body=b'User-agent: *\nDisallow: /restricted'))
    with pytest.raises(FetchError, match='robots explicitly disallows') as error:
        client.fetch('https://example.org/restricted', 'fixture')
    assert len(session.calls) == 1
    assert error.value.category == 'robots_disallowed'

def test_unavailable_robots_fails_closed(client_factory):
    client, session = client_factory(Response(503))
    with pytest.raises(FetchError, match='robots'):
        client.fetch('https://example.org/data', 'fixture')
    assert len(session.calls) == 1

def test_retry_after_then_success(client_factory, monkeypatch):
    sleeps = []
    monkeypatch.setattr('nihao_ingest.http.time.sleep', sleeps.append)
    client, session = client_factory(Response(404), Response(429, headers={'Retry-After': '3'}), Response(body=b'data', headers={'Content-Length': '4'}))
    result = client.fetch('https://example.org/data', 'fixture')
    assert 3 in sleeps
    assert Path(result['path']).read_bytes() == b'data'
    assert len(session.calls) == 3

def test_long_retry_is_deferred_not_bypassed(client_factory):
    client, session = client_factory(Response(404), Response(429, headers={'Retry-After': '600'}))
    with pytest.raises(FetchError, match='retry deferred'):
        client.fetch('https://example.org/data', 'fixture')
    assert len(session.calls) == 2

def test_download_size_budget_before_body(client_factory):
    client, _ = client_factory(Response(404), Response(headers={'Content-Length': '100'}))
    with pytest.raises(FetchError, match='budget'):
        client.fetch('https://example.org/data', 'fixture', max_bytes=10)

def test_stream_budget_when_size_missing(client_factory):
    client, _ = client_factory(Response(404), Response(body=b'0123456789'))
    with pytest.raises(FetchError, match='budget'):
        client.fetch('https://example.org/data', 'fixture', max_bytes=9)

def test_total_budget(client_factory):
    client, _ = client_factory(Response(404), Response(body=b'123456', headers={'Content-Length': '6'}), max_total_mb=5/1024/1024)
    with pytest.raises(FetchError, match='budget'):
        client.fetch('https://example.org/data', 'fixture', max_bytes=10)

def test_retry_resume_uses_validator_and_range(client_factory):
    client, session = client_factory(Response(404), Response(headers={'Content-Length': '6', 'ETag': '"one"'}, chunks=[b'abc', requests.ConnectionError('fixture interruption')]), Response(206, body=b'def', headers={'Content-Length':'3', 'Content-Range':'bytes 3-5/6', 'ETag':'"one"'}))
    result = client.fetch('https://example.org/data', 'fixture')
    assert Path(result['path']).read_bytes() == b'abcdef'
    headers = session.calls[-1][2]['headers']
    assert headers['Range'] == 'bytes=3-'
    assert headers['If-Range'] == '"one"'
    assert result['bytes'] == 6

def test_changed_etag_rejected_without_corruption(client_factory):
    client, _ = client_factory(Response(404), Response(headers={'Content-Length':'6', 'ETag':'"one"'}, chunks=[b'abc', requests.ConnectionError('interrupted')]), Response(206, body=b'xyz', headers={'Content-Length':'3', 'Content-Range':'bytes 3-5/6', 'ETag':'"two"'}))
    with pytest.raises(FetchError, match='ETag changed'):
        client.fetch('https://example.org/data', 'fixture')
    assert not list(client.root.glob('raw/fixture/*/*.bin'))

def test_ignored_range_restarts_instead_of_appending(client_factory):
    client, _ = client_factory(Response(404), Response(headers={'Content-Length':'6', 'ETag':'"one"'}, chunks=[b'abc', requests.ConnectionError('interrupted')]), Response(200, body=b'uvwxyz', headers={'Content-Length':'6', 'ETag':'"two"'}))
    result = client.fetch('https://example.org/data', 'fixture')
    assert Path(result['path']).read_bytes() == b'uvwxyz'

def test_exact_url_cache_dedup_does_not_redownload(client_factory):
    client, session = client_factory(Response(404), Response(body=b'hello', headers={'Content-Length':'5'}))
    one = client.fetch('https://example.org/data?version=1', 'fixture')
    two = client.fetch('https://example.org/data?version=1', 'fixture')
    assert one['path'] == two['path'] and two['cached']
    assert len(session.calls) == 2

def test_redirect_target_checked_before_fetch(client_factory):
    client, session = client_factory(Response(404), Response(302, headers={'Location':'https://restricted.example/data'}), Response(body=b'User-agent: *\nDisallow: /'))
    with pytest.raises(FetchError, match='robots'):
        client.fetch('https://example.org/data', 'fixture')
    assert [url for _, url, _ in session.calls] == ['https://example.org/robots.txt', 'https://example.org/data', 'https://restricted.example/robots.txt']

def test_resume_requires_correct_offset(client_factory):
    client, _ = client_factory(Response(404), Response(headers={'ETag':'"v1"'}, chunks=[b'abc', requests.ConnectionError('interruption')]), Response(206, body=b'def', headers={'Content-Range':'bytes 2-4/6','ETag':'"v1"'}))
    with pytest.raises(FetchError, match='Content-Range'):
        client.fetch('https://example.org/data', 'fixture')

def test_bad_json_does_not_become_records(client_factory):
    client, _ = client_factory(Response(404), Response(body=b'not json'))
    with pytest.raises(FetchError, match='JSON parse'):
        client.json('https://example.org/data', 'fixture')

def test_source_key_identity_is_stable_and_unambiguous():
    assert stable_id('fixture', '123') == stable_id('fixture', '123')
    assert stable_id('a|b', 'c') != stable_id('a', 'b|c')


def test_changed_last_modified_rejected_on_resume(client_factory):
    client, _ = client_factory(Response(404), Response(headers={'Content-Length':'6','Last-Modified':'Mon, 09 Nov 2026 12:00:00 GMT'},chunks=[b'abc',requests.ConnectionError('interrupted')]),Response(206,body=b'xyz',headers={'Content-Length':'3','Content-Range':'bytes 3-5/6','Last-Modified':'Mon, 09 Nov 2026 13:00:00 GMT'}))
    with pytest.raises(FetchError,match='Last-Modified changed'):
        client.fetch('https://example.org/data','fixture')
    assert not list(client.root.glob('raw/fixture/*/*.bin'))


def test_robots_wildcard_and_more_specific_allow(client_factory):
    body=b'User-agent: *\nDisallow: /*?secret=*\nDisallow: /private/*\nAllow: /private/public$\n'
    client, session=client_factory(Response(body=body),Response(body=b'public'))
    assert not client.robots('https://example.org/page?secret=one')['allowed']
    assert not client.robots('https://example.org/private/hidden')['allowed']
    assert client.robots('https://example.org/private/public')['allowed']
    result=client.fetch('https://example.org/private/public','fixture')
    assert Path(result['path']).read_bytes()==b'public'
    assert len(session.calls)==2


def test_download_records_sha256_and_detects_tampered_cache(client_factory):
    import hashlib
    client,session=client_factory(Response(404),Response(body=b'original',headers={'Content-Length':'8'}))
    result=client.fetch('https://example.org/data','fixture')
    assert result['sha256']==hashlib.sha256(b'original').hexdigest() and result['sha256_verified']
    Path(result['path']).write_bytes(b'modified')
    with pytest.raises(FetchError,match='cached SHA256 mismatch') as error:
        client.fetch('https://example.org/data','fixture')
    assert error.value.category=='integrity_error'
    assert len(session.calls)==2


def test_gzip_content_length_is_encoded_not_decoded(client_factory):
    # requests.iter_content supplies decoded data; compressed wire length differs.
    client,_=client_factory(Response(404),Response(body=b'decoded response body',headers={'Content-Length':'5','Content-Encoding':'gzip'}))
    result=client.fetch('https://example.org/data','fixture')
    assert result['bytes']==len(b'decoded response body')
    assert result['content_encoding']=='gzip'

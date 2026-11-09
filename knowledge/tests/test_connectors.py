from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from nihao_ingest.connectors.commons import license_gate, ingest as commons_ingest
from nihao_ingest.connectors.unesco import license_is_open, select_field, china_value
from nihao_ingest.connectors.geofabrik import domain_for, ingest as osm_ingest


def meta(**changes):
    result = {'LicenseShortName': {'value':'CC BY-SA 4.0'}, 'LicenseUrl': {'value':'https://creativecommons.org/licenses/by-sa/4.0/'}, 'Artist':{'value':'Fixture artist'}, 'UsageTerms':{'value':'Creative Commons Attribution-ShareAlike 4.0'}}
    result.update({key:{'value':value} for key,value in changes.items()})
    return result


def test_license_gate_explicit_commercial_license():
    license, url, reason = license_gate(meta())
    assert license == 'CC-BY-SA-4.0'
    assert url.startswith('https://creativecommons.org/')
    assert reason is None

@pytest.mark.parametrize('changes', [{'LicenseUrl':''}, {'LicenseUrl':'https://example.org/arbitrary-license'}, {'Artist':''}, {'Restrictions':'trademark permission needed'}, {'LicenseShortName':'CC BY-NC 4.0'}, {'UsageTerms':'No derivatives'}, {'UsageTerms':'All rights reserved'}])
def test_license_gate_rejects_ambiguous_or_restricted_metadata(changes):
    license, _url, reason = license_gate(meta(**changes))
    assert license is None and reason


def test_rejected_media_never_downloads_binary(tmp_path, monkeypatch):
    ctx = SimpleNamespace(root=tmp_path, max_items=5, max_images=2, max_videos=1, event=Mock(), review=Mock(), http=SimpleNamespace(fetch=Mock()))
    source = {'source_id':'wikimedia_commons_attractions','domains':['attractions'], 'url':'https://example.org/category','collection_route':'action_api'}
    monkeypatch.setattr('nihao_ingest.connectors.commons.p18_candidates', lambda *_: [])
    monkeypatch.setattr('nihao_ingest.connectors.commons.category_candidates', lambda *_: [{'title':'File:Fixture.jpg'}])
    monkeypatch.setattr('nihao_ingest.connectors.commons.mw', lambda *_a, **_kw: ({'query':{'pages':[{'pageid':1,'imageinfo':[{'extmetadata':meta(LicenseUrl=''), 'descriptionurl':'https://example.org/File:Fixture.jpg', 'url':'https://upload.wikimedia.org/fixture.jpg', 'size':20, 'mime':'image/jpeg'}]}]}}, {}))
    assert commons_ingest(source, ctx) == []
    ctx.http.fetch.assert_not_called()
    ctx.review.assert_called_once()


def test_full_osm_flag_blocks_download_by_default(tmp_path):
    ctx = SimpleNamespace(root=tmp_path, full_osm=False, event=Mock(), http=SimpleNamespace(fetch=Mock()))
    assert osm_ingest({'source_id':'full','requires_flag':'full-osm'}, ctx) == []
    ctx.http.fetch.assert_not_called()


def test_unesco_license_only_accepts_license_fields():
    assert license_is_open({'metas':{'default':{'license':'CC BY-SA 4.0'}}})
    assert not license_is_open({'description':'CC BY-SA 4.0', 'metas':{'default':{'license':'unknown'}}})
    assert not license_is_open({'metas':{'default':{'license':'CC BY-NC 4.0'}}})


def test_unesco_country_and_dynamic_schema_parser():
    assert china_value('China') and china_value(['Japan','China']) and china_value('CHN')
    assert not china_value('A festival influenced by China')
    assert not china_value('China Town')
    fields = [{'name':'state_names','label':'States parties', 'type':'text'},{'name':'location','type':'geo_point_2d'}]
    assert select_field(fields, ['country'], ['states part']) == 'state_names'
    assert select_field(fields, ['missing'], ['nothing']) is None

@pytest.mark.parametrize('tags,expected',[({'railway':'station'},'transportation'),({'tourism':'museum'},'attractions'),({'amenity':'hospital'},'daily_life'),({'shop':'unknown'},None)])
def test_osm_domain_parser(tags, expected):
    assert domain_for(tags) == expected


def test_commons_footer_license_cannot_authorize_file_binary():
    from bs4 import BeautifulSoup
    from nihao_ingest.connectors.commons import file_html_metadata
    html='<html><div id="footer-info-copyright"><a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a></div><div class="fullMedia"><a class="internal" href="https://upload.wikimedia.org/file.jpg">original</a></div></html>'
    with pytest.raises(ValueError,match='per-file HTML license'):
        file_html_metadata(BeautifulSoup(html,'html.parser'),html,'https://commons.wikimedia.org/wiki/File:Test.jpg')


def test_article_license_comes_from_copyright_footer_only():
    from bs4 import BeautifulSoup
    from nihao_ingest.connectors.html_pages import article_license
    body_only='<html><p>CC BY-SA 4.0 <a href="https://creativecommons.org/licenses/by-sa/4.0/">license</a></p></html>'
    with pytest.raises(ValueError,match='copyright footer'):
        article_license(BeautifulSoup(body_only,'html.parser'))


def test_commons_html_empty_author_cell_requires_review():
    from bs4 import BeautifulSoup
    from nihao_ingest.connectors.commons import file_html_metadata
    html='''<html><script>{"wgArticleId":123,"wgRevisionId":456}</script><table><tr><td id="fileinfotpl_aut">Author</td><td> <span> </span> </td></tr></table><div class="licensetpl"><span class="licensetpl_short">CC BY-SA 4.0</span><span class="licensetpl_link">https://creativecommons.org/licenses/by-sa/4.0/</span></div><div class="fullMedia"><a class="internal" href="https://upload.wikimedia.org/file.jpg">Original</a><span class="mime-type">image/jpeg</span></div></html>'''
    with pytest.raises(ValueError,match='author|Author|attribution'):
        file_html_metadata(BeautifulSoup(html,'html.parser'),html,'https://commons.wikimedia.org/wiki/File:Test.jpg')


def pd_author_html(author='Alice Example', grant=True):
    declaration='This work has been released into the public domain by its author, Alice Example. This applies worldwide. '
    if grant:declaration+='Alice Example grants anyone the right to use this work for any purpose, without any conditions.'
    return '<html><script>{"wgArticleId":123,"wgRevisionId":456}</script><div id="mw-content-text"><table class="layouttemplate"><tr><td><span class="licensetpl_short">Public domain</span><p>'+declaration+'</p></td></tr></table></div><table><tr><td id="fileinfotpl_aut">Author</td><td>'+author+'</td></tr></table><div class="fullMedia"><a class="internal" href="https://upload.wikimedia.org/original.webm">Original</a><span class="mime-type">video/webm</span></div></html>'


def test_pd_author_requires_explicit_matching_author_worldwide_grant():
    from bs4 import BeautifulSoup
    from nihao_ingest.connectors.commons import file_html_metadata
    raw=pd_author_html()
    page,license,url,_=file_html_metadata(BeautifulSoup(raw,'html.parser'),raw,'https://commons.wikimedia.org/wiki/File:Original.webm')
    assert license=='Public-domain' and license!='CC0'
    assert page['licensing_evidence']['method']=='explicit per-file PD-author release'
    assert 'without any conditions' in page['licensing_evidence']['declaration']
    for invalid in (pd_author_html(grant=False),pd_author_html(author=''),pd_author_html(author='Different Creator'),raw.replace('This applies worldwide.','')):
        with pytest.raises(ValueError,match='per-file HTML license'):
            file_html_metadata(BeautifulSoup(invalid,'html.parser'),invalid,'https://commons.wikimedia.org/wiki/File:Original.webm')


def test_public_domain_label_alone_is_not_permission():
    from bs4 import BeautifulSoup
    from nihao_ingest.connectors.commons import file_html_metadata
    raw='<html><div id="mw-content-text"><table class="layouttemplate"><span class="licensetpl_short">Public domain</span></table></div></html>'
    with pytest.raises(ValueError,match='per-file HTML license'):
        file_html_metadata(BeautifulSoup(raw,'html.parser'),raw,'https://commons.wikimedia.org/wiki/File:Original.webm')


def test_targeted_commons_request_uses_only_exact_claimed_qids(tmp_path,monkeypatch):
    from nihao_ingest.connectors.commons import ingest
    ctx=SimpleNamespace(root=tmp_path,max_items=5,max_images=31,max_videos=1,event=Mock(),review=Mock(),http=SimpleNamespace(fetch=Mock()))
    source={'source_id':'wikimedia_commons_attractions','domains':['attractions'],'target_qids':['Q12501']}
    monkeypatch.setattr('nihao_ingest.connectors.commons.p18_candidates',lambda *_:[{'title':'File:Great Wall.jpg','qid':'Q12501'},{'title':'File:Other.jpg','qid':'Q9'}])
    category=Mock(side_effect=AssertionError('targeted request must not broaden discovery'))
    monkeypatch.setattr('nihao_ingest.connectors.commons.category_html_candidates',category)
    page=Mock(side_effect=ValueError('Mocked metadata failure before any binary'))
    monkeypatch.setattr('nihao_ingest.connectors.html_pages.read_page',page)
    assert ingest(source,ctx)==[]
    category.assert_not_called();ctx.http.fetch.assert_not_called()
    assert page.call_count==1 and page.call_args.args[-1].endswith('/wiki/File:Great_Wall.jpg')


@pytest.mark.parametrize('target',['Q12501',['not-a-qid'],[123]])
def test_targeted_commons_qids_require_valid_explicit_list(tmp_path,monkeypatch,target):
    from nihao_ingest.connectors.commons import ingest
    ctx=SimpleNamespace(root=tmp_path,max_items=5,max_images=31,max_videos=1,event=Mock(),review=Mock())
    monkeypatch.setattr('nihao_ingest.connectors.commons.p18_candidates',lambda *_:[])
    with pytest.raises(ValueError,match='list of exact Wikidata QIDs'):
        ingest({'source_id':'wikimedia_commons_attractions','domains':['attractions'],'target_qids':target},ctx)

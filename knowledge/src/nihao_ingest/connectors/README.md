# Collector behavior and limits

All production network access goes through the shared HTTP client. The CLI must
complete source validation before calling `ingest_source`; connectors do not
supply a crawler identity or bypass a failed robots/access check. Unknown or
restricted sources remain metadata-only or blocked. The original 13 sources are
registered independently, even when they share an API.

- **Wikidata:** bounded curated discovery titles in `config/pilot_entities.yaml`
  resolve to actual QIDs from canonical Wikipedia item links, then official
  format-qualified Linked Data JSON provides the full entity. An optional
  permitted Action API route resolves exact enwiki sitelinks in small batches.
  Inputs are query/title strings, never claimed entity records. Structured data
  remain CC0 and P18 claims provide exact filename evidence for Commons links.
- **UNESCO:** live dataset metadata must explicitly show CC BY-SA 4.0. Field names
  are selected from the returned schema. A schema-derived country query is first
  tested using the records endpoint, then a capped JSON export is requested.
  Each exported record must also have an explicit China country token locally.
  Metadata endpoints and export URLs are persisted. This license applies to the
  dataset, not to photographs or videos linked from its records; those binaries
  are never downloaded by this connector.
- **Geofabrik:** only the official Beijing snapshot unless `--full-osm` is set.
  The complete allowed snapshot is kept locally; pyosmium extracts a bounded
  sample of named attraction, transportation and daily-life **nodes**. Ways and
  relations are retained in the raw snapshot but not falsely reported as parsed
  POIs. OSM `wikidata` tags can provide exact external identifiers. ODbL and
  OpenStreetMap contributor attribution are preserved.
- **Commons:** discovery uses seed categories (maximum depth 2, 12 bounded API
  pages) and already ingested Wikidata P18 images. Every candidate needs
  source metadata from API imageinfo or a canonical file page, supported MIME,
  bounded byte size, supported license URL and
  author provenance. CC BY/CC BY-SA 1.0–4.0, CC0, and explicit public-domain-mark
  files can pass; any extra restrictions, NC/ND terms or missing evidence go to
  rights review without downloading the binary. Current supported image formats
  are JPEG, PNG, WebP and GIF; videos are WebM, MP4 and Ogg. Media files are limited
  to 12 MiB/image and 80 MiB/video. Only Wikimedia's upload host is accepted as an
  original download origin. Entity links use exact P18 filenames or a single
  nondeprecated MediaInfo P180 depicts QID; filenames alone never cause merges.
  Audio MIME handling is defined for future extensions, but current seed targets
  do not ingest audio. Unknown captions/OCR/transcripts remain pending.
- **Wikivoyage:** the canonical page copyright footer or, for an allowed API
  route, `siteinfo.rightsinfo` must establish a supported CC BY-SA license.
  Up to six configured pages provide substantive source text, with revision ID,
  timestamp, attribution and history links. These records retain ShareAlike and
  remain distinct from CC0 data. Current travel rules still require live official
  verification; page access does not guarantee factual freshness.
- **Official NIA, gov.cn and 12306:** registry metadata only. Titles are local
  descriptive labels, not scraped page titles. No response body or unauthorized
  images are requested by these connectors. Registry entries are not counted as
  successful downloaded documents and cannot answer current policy questions.

## Corrected access handling and executed routes

The initial 2026-11-09 run correctly observed robots exclusions for `/sparql`,
Wikimedia `/w/` APIs, and UNESCO `/api/`, but incorrectly treated these as blocking
all data access for those providers. The corrected pilot preserves every robots
restriction and uses permitted public routes documented by Wikimedia:

- [Wikidata Data access](https://www.wikidata.org/wiki/Wikidata:Data_access):
  explicit `Special:EntityData/QID.json` linked-data exports are supported.
  The format-qualified `.json` routes are separately allowed by robots.
- [Wikimedia Robot policy](https://wikitech.wikimedia.org/wiki/Robot_policy):
  preferred cached canonical pages and all applicable robots directives are
  respected. This is not an override of blocked Action API routes.
- Canonical bilingual Wikipedia articles provide explicit Wikidata-item links,
  page IDs, revision IDs and article copyright footers. HTML extraction retains
  headings and paragraphs, removes navigation/infobox/reference machinery, and
  records the transformation. Exact article QIDs are checked against Wikidata
  sitelinks before linking. Full real article text is used, not synthetic facts
  or tiny summary fragments created to inflate chunk counts.
- Canonical Commons file pages provide **per-file** licensing templates, authors,
  original descriptions and binary links. Only supported licenses in those
  templates authorize binary download; Commons' general footer license never
  licenses the image/video. Original-file HEAD and bounded GET validate sizes.
  P18 is exact entity evidence. Category HTML discovery supplies video candidates;
  candidates without verified entity evidence remain unlinked.
- Canonical Wikivoyage pages provide licensed national and city guide text,
  revision provenance and attribution. Visa rules retain mandatory live-source
  verification in retrieval.
- UNESCO APIs still remain blocked when the source's robots rules disallow them;
  no browser spoofing, authentication bypass, proxy or cached copy is used.

API collector implementations are retained behind `collection_route: action_api`
for environments where those routes are authorized and allowed; the common HTTP
client always enforces their current robots policy.

## Identity, SHA-256 and byte accounting

The latest explicit user instruction restores SHA-256 for this corrected Pilot.
The common HTTP client records raw response digests; normalized records and
media processing verify source and binary digests, and content identity supports
cross-source deduplication. Source identifiers, original URLs, revisions and
raw metadata remain available independently of content identity.

A hardlink may provide a decoder-friendly `.osm.pbf` extension or an asset path
without retransferring/copying the content. HTTP transfer logs, rather than a sum
over hardlinked paths, are authoritative for actual transferred bytes. Unique
physical file accounting must deduplicate inode references.

## Exact entity follow-up

A Commons source may set `target_qids: [Q12501]` for a bounded follow-up.
The canonical collector then selects only existing, nondeprecated Wikidata
P18/P10 claims for those exact QIDs and disables category discovery entirely.
Global image/video caps and per-file rights and size gates still apply. This
supports filling a genuinely missing modality without inventing identity from
similar filenames or collecting unrelated files.

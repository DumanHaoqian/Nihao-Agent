from __future__ import annotations
import argparse, json, os, sys, time
from pathlib import Path
from .core import Context, read_jsonl, write_jsonl, utcnow, stable_id
from .validation import load_registry, validate_sources
from .http import HttpClient, FetchError


def make_parser():
    p=argparse.ArgumentParser(description='Nihao independent ingestion engine (no Harness modifications)')
    p.add_argument('command',choices=['validate-sources','dry-run','ingest','normalize','entity-link','media-process','audit','report','query','serve','withdraw-source','evaluate','index','quarantine-source','acceptance'])
    p.add_argument('--registry',default='config/sources.yaml');p.add_argument('--data-dir',default='data');p.add_argument('--reports-dir',default='reports')
    p.add_argument('--profile',choices=['pilot'],default='pilot');p.add_argument('--max-total-mb',type=float,default=500)
    p.add_argument('--max-items',type=int,default=50);p.add_argument('--max-images',type=int,default=15);p.add_argument('--max-videos',type=int,default=2)
    p.add_argument('--full-osm',action='store_true');p.add_argument('--source',action='append');p.add_argument('--question',default='');p.add_argument('--domain')
    p.add_argument('--entity-qid',action='append');p.add_argument('--reason');p.add_argument('--host',default='127.0.0.1');p.add_argument('--port',type=int,default=8790)
    return p

def main(argv=None):
    args=make_parser().parse_args(argv);root=Path(args.data_dir).resolve();reports=Path(args.reports_dir).resolve()
    if args.max_total_mb<=0 or args.max_items<1 or args.max_images<0 or args.max_videos<0: raise SystemExit('invalid limits')
    registry=load_registry(args.registry)
    if args.entity_qid:
        import re
        if not args.source or any(not re.fullmatch(r'Q[1-9][0-9]*',v) for v in args.entity_qid):raise SystemExit('--entity-qid requires --source and valid Q IDs')
    if args.source and any(s not in {r['source_id'] for r in registry['sources']} for s in args.source):raise SystemExit('unknown --source')
    try:
        if args.command=='dry-run':
            val=root/'manifests/source_validation.json';states={s['source_id']:s for s in json.loads(val.read_text())} if val.exists() else {}
            result=dict(profile='pilot',generated_at=utcnow(),max_total_bytes=int(args.max_total_mb*1024*1024),max_records_per_source=args.max_items,max_images_per_category=args.max_images,max_videos_per_category=args.max_videos,full_osm=args.full_osm,contact_configured=bool(os.getenv('NIHAO_CONTACT')),sources=[dict(source_id=s['source_id'],strategy=s['access_strategy'],status=states.get(s['source_id'],{}).get('status','unvalidated'),maximum_records=0 if s.get('requires_flag') and not args.full_osm else args.max_items,estimated_bytes=states.get(s['source_id'],{}).get('expected_bytes'),reason='explicit --full-osm required' if s.get('requires_flag') and not args.full_osm else 'unknown byte estimates are not promises') for s in registry['sources']])
            reports.mkdir(parents=True,exist_ok=True);(reports/'dry_run.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2));return 0
        if args.command=='validate-sources':
            validate_sources(registry,root,HttpClient(root,max_total_mb=args.max_total_mb),args.full_osm);return 0
        if args.command=='ingest':
            from .connectors import ingest_source
            validation=root/'manifests/source_validation.json'
            if not validation.exists():raise FetchError('Run validate-sources before ingest')
            states={r['source_id']:r for r in json.loads(validation.read_text())}
            client=HttpClient(root,max_total_mb=args.max_total_mb)
            version=utcnow().replace(':','-');started=time.monotonic();previous={r['id']:r for r in read_jsonl(root/'manifests/records.jsonl')}
            outcomes=[]
            for source in registry['sources']:
                sid=source['source_id']
                if args.source and sid not in args.source:continue
                if args.entity_qid:source=dict(source,target_qids=args.entity_qid)
                ctx=Context(root,client,source,version,args.max_items,args.max_images,args.max_videos,args.full_osm)
                state=states.get(sid,{})
                withdrawn={r['source_id'] for r in read_jsonl(root/'manifests/withdrawals.jsonl')}
                quarantined={r['source_id'] for r in read_jsonl(root/'manifests/quarantines.jsonl')}
                if sid in quarantined:
                    ctx.event(sid,'skipped','source quarantined; explicit access/rights resolution required');outcomes.append(dict(source_id=sid,status='quarantined',records=0));continue
                if sid in withdrawn:
                    ctx.event(sid,'skipped','source withdrawn; rights review required before reintroduction');outcomes.append(dict(source_id=sid,status='withdrawn',records=0));continue
                if source.get('requires_flag') and not args.full_osm:
                    ctx.event(sid,'skipped','requires explicit --full-osm');outcomes.append(dict(source_id=sid,status='skipped',records=0));continue
                if state.get('checked_at','')[:10]!=utcnow()[:10]:
                    ctx.event(sid,'skipped','source validation expired; revalidate today');outcomes.append(dict(source_id=sid,status='skipped',records=0));continue
                if state.get('status')!='eligible' and source['access_strategy']!='metadata_only':
                    ctx.event(sid,'skipped',state.get('reason','source not validated'));outcomes.append(dict(source_id=sid,status='skipped',records=0));continue
                try:
                    rows=ingest_source(source,ctx)
                    for row in rows:previous[row['id']]=row
                    write_jsonl(root/'manifests/records.jsonl',previous.values())
                    outcomes.append(dict(source_id=sid,status='completed' if rows else 'empty',records=len(rows)))
                    print(f'{sid}: {len(rows)} persisted records',flush=True)
                except Exception as e:
                    ctx.event(sid,'failed',str(e));outcomes.append(dict(source_id=sid,status='failed',records=0,error=str(e)));print(f'{sid}: FAILED {e}',flush=True)
            result=dict(run_id=version,started_at=version,ended_at=utcnow(),elapsed_seconds=round(time.monotonic()-started,3),network_bytes=client.transferred,budget_bytes=client.max_bytes,outcomes=outcomes,checksums='sha256_local_integrity_enabled_by_explicit_user_request')
            path=root/'manifests/runs'/f'{version}.summary.json';path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(result,indent=2))
            print(json.dumps(result,indent=2));return 0
        if args.command in ('normalize','entity-link','media-process','audit','withdraw-source','quarantine-source'):
            from . import pipelines
            if args.command=='quarantine-source':
                if not args.source or not args.reason:raise FetchError('quarantine-source requires --source and --reason')
                result=[pipelines.quarantine_source(root,s,args.reason) for s in args.source]
            elif args.command=='withdraw-source':
                if not args.source:raise FetchError('withdraw-source requires --source')
                result=[pipelines.withdraw_source(root,s) for s in args.source]
            else:result=getattr(pipelines,{'entity-link':'link','media-process':'process_media'}.get(args.command,args.command))(root)
            print(json.dumps(result,indent=2,default=str));return int(args.command=='audit' and bool(result.get('issues')))
        if args.command=='acceptance':
            from .acceptance import accept
            result=accept(root)
            print(json.dumps(result,indent=2,default=str));return 0 if result.get('passed') else 1
        if args.command=='report':
            from .reporting import report
            print(json.dumps(report(root,reports,registry),indent=2));return 0
        if args.command=='index':
            from .retrieval import build_index
            print(json.dumps(build_index(root),indent=2,default=str));return 0
        if args.command=='query':
            from .retrieval import query
            print(json.dumps(query(root,args.question,args.domain),ensure_ascii=False,indent=2));return 0
        if args.command=='serve':
            from .retrieval import serve
            serve(root,args.host,args.port);return 0
        if args.command=='evaluate':
            from .retrieval.evaluation import evaluate
            print(json.dumps(evaluate(root,report_path=reports/'retrieval_evaluation.json'),indent=2));return 0
    except (FetchError,ValueError) as e:
        print(str(e),file=sys.stderr);return 2
    return 0

if __name__=='__main__':sys.exit(main())

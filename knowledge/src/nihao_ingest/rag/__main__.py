import argparse,json
from . import Engine
p=argparse.ArgumentParser();p.add_argument('command',choices=['build','query','image','visual-text']);p.add_argument('--input');a=p.parse_args();e=Engine()
r=e.build() if a.command=='build' else e.search(a.input) if a.command=='query' else e.visual(image=a.input) if a.command=='image' else e.visual(text=a.input)
print(json.dumps(r,ensure_ascii=False,indent=2))

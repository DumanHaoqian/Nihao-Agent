"""Published JSON Schema contracts, including future audio assets."""
import json
from pathlib import Path
from functools import lru_cache
from jsonschema import Draft202012Validator, FormatChecker

@lru_cache(maxsize=None)
def schema_for(table):
    if table not in ('sources','entities','documents','chunks','media','media_segments','links'):
        raise ValueError('Unknown normalized table: '+table)
    return json.loads((Path(__file__).parent/(table+'.schema.json')).read_text())

def validate_record(table, record):
    Draft202012Validator(schema_for(table),format_checker=FormatChecker()).validate(record)

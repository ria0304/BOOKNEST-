import sqlite3
import os
import sys
import glob
import json
import time

import pyarrow as pa

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bookhaven.db')
CACHE_GLOB = os.path.expanduser(
    '~/.cache/huggingface/datasets/BrightData___goodreads-books/default/*/*/*.arrow'
)
BATCH_ROWS = 20000


def clean_str(val, max_len=None):
    if val is None:
        return None
    s = str(val).strip()
    if s in ("", "None", "null", "nan"):
        return None
    if max_len and len(s) > max_len:
        s = s[:max_len]
    return s


def parse_author(val):
    """Goodreads authors are often stored as JSON strings like ['Author Name']"""
    s = clean_str(val)
    if not s:
        return "Unknown Author"
    if s.startswith("["):
        try:
            lst = json.loads(s)
            if isinstance(lst, list):
                return clean_str(", ".join(str(x).strip() for x in lst if x), 300)
        except:
            return s.strip("[]").replace('"', '').replace("'", "").strip()
    return clean_str(s, 300)


def open_shard(path):
    """Return (kind, reader, src). Caller must close src when done."""
    src = pa.memory_map(path, 'rb')
    try:
        return ('file', pa.ipc.open_file(src), src)
    except pa.ArrowInvalid:
        src.close()

    src = pa.memory_map(path, 'rb')
    try:
        return ('stream', pa.ipc.open_stream(src), src)
    except pa.ArrowInvalid:
        src.close()
        raise


def iter_batches(files):
    for f in files:
        kind, reader, src = open_shard(f)
        try:
            if kind == 'file':
                for i in range(reader.num_record_batches):
                    yield reader.get_batch(i)
            else:
                for batch in reader:
                    yield batch
        finally:
            src.close()


print(f" Database: {DB_PATH}")

if not os.path.exists(DB_PATH):
    print(" Error: bookhaven.db not found. Run import_goodreads.py first.")
    sys.exit(1)

conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

if not cur.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='goodreads_books'"
).fetchone():
    print(" Error: goodreads_books table missing. Run import_goodreads.py first.")
    sys.exit(1)

start = cur.execute("SELECT seq FROM sqlite_sequence WHERE name='goodreads_books'").fetchone()
start = start[0] if start and start[0] else 0
existing = cur.execute("SELECT COUNT(*) FROM goodreads_books").fetchone()[0]
print(f" Existing rows: {existing:,} (last rowid {start:,})")

files = sorted(glob.glob(CACHE_GLOB))
if not files:
    print(f" Error: no Arrow shards found at {CACHE_GLOB}")
    sys.exit(1)
print(f" Arrow shards: {len(files)}\n")

total = 0
for f in files:
    kind, reader, src = open_shard(f)
    try:
        if kind == 'file':
            total += sum(reader.get_batch(i).num_rows for i in range(reader.num_record_batches))
        else:
            total += sum(b.num_rows for b in reader)
    finally:
        src.close()
print(f" Dataset rows: {total:,}")
print(f" Resuming from row {existing:,} -> {total:,} ({total - existing:,} remaining)\n")

if existing >= total:
    print(" Already complete. Nothing to do.")
    conn.close()
    sys.exit(0)

INSERT = '''
    INSERT INTO goodreads_books 
    (title, author, star_rating, num_ratings, num_reviews, summary, genres, first_published, goodreads_url) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
'''

COLS = ['name', 'author', 'star_rating', 'num_ratings', 'num_reviews',
        'summary', 'genres', 'first_published', 'url']

offset = 0
inserted = 0
errors = 0
pending = []
t0 = time.time()


def flush(force=False):
    global inserted
    if not pending or (not force and len(pending) < BATCH_ROWS):
        return
    cur.executemany(INSERT, pending)
    conn.commit()
    inserted += len(pending)
    done = offset + len(pending)
    rate = inserted / max(time.time() - t0, 0.001)
    eta = (total - done) / max(rate, 0.001)
    print(f"    {done:,} / {total:,}  ({done / total * 100:.1f}%)  "
          f"errors={errors:,}  {rate:,.0f} rows/s  eta={eta / 60:.1f}m", flush=True)
    pending.clear()


for batch in iter_batches(files):
    n = batch.num_rows
    lo, hi = offset, offset + n

    if hi > start:
        sub = batch.slice(max(0, start - offset))
        data = {c: sub.column(c).to_pylist() for c in COLS}
        for i in range(sub.num_rows):
            try:
                pending.append((
                    clean_str(data['name'][i], 500),
                    parse_author(data['author'][i]),
                    data['star_rating'][i],
                    data['num_ratings'][i],
                    data['num_reviews'][i],
                    clean_str(data['summary'][i], 5000),
                    clean_str(data['genres'][i], 500),
                    clean_str(data['first_published'][i], 50),
                    clean_str(data['url'][i], 500),
                ))
            except Exception:
                errors += 1
        flush()

    offset = hi
    flush(force=True)

flush(force=True)

final_count = cur.execute("SELECT COUNT(*) FROM goodreads_books").fetchone()[0]
print("\n" + "=" * 40)
print(" RESUME COMPLETE")
print(f"   Total Rows: {final_count:,}")
print(f"   Added:     {inserted:,}")
print(f"   Errors:    {errors:,}")
print("=" * 40)

conn.close()
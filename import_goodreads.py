"""
Import the BrightData/Goodreads-Books dataset into SQLite.

Crash-safe by design:
  * Arrow shards are streamed record-batch by record-batch and never
    materialised as a whole, so memory stays flat regardless of dataset size.
  * Rows are committed in batches and the resume point is read from
    sqlite_sequence, so re-running after a crash continues instead of
    restarting. Pass --fresh to rebuild the table from scratch.

This deliberately avoids `datasets.Dataset.select()`, which spawns a
multiprocess pool that is unstable on Python 3.14 and previously killed the
import mid-run.

Usage:
    python import_goodreads.py            # resume (or no-op if complete)
    python import_goodreads.py --fresh    # drop the table and re-import
    python import_goodreads.py --rebuild-fts
"""

import argparse
import glob
import json
import os
import sqlite3
import sys
import time

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bookhaven.db')
CACHE_GLOB = os.path.expanduser(
    '~/.cache/huggingface/datasets/BrightData___goodreads-books/default/*/*/*.arrow'
)
BATCH_ROWS = 20000

COLUMNS = ['name', 'author', 'star_rating', 'num_ratings', 'num_reviews',
           'summary', 'genres', 'first_published', 'url']

INSERT = '''
    INSERT INTO goodreads_books
    (title, author, star_rating, num_ratings, num_reviews, summary, genres, first_published, goodreads_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
'''


def clean_str(val, max_len=None):
    if val is None:
        return None
    s = str(val).strip()
    if s in ('', 'None', 'null', 'nan'):
        return None
    if max_len and len(s) > max_len:
        s = s[:max_len]
    return s


def parse_author(val):
    """Goodreads authors are often stored as JSON strings like ['Author Name']"""
    s = clean_str(val)
    if not s:
        return 'Unknown Author'
    if s.startswith('['):
        try:
            lst = json.loads(s)
            if isinstance(lst, list):
                return clean_str(', '.join(str(x).strip() for x in lst if x), 300)
        except Exception:
            return s.strip('[]').replace('"', '').replace("'", '').strip()
    return clean_str(s, 300)


def open_shard(path):
    """Return (kind, reader, src). Caller must close src when done."""
    import pyarrow as pa

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
    """Yield every record batch in the dataset, holding only one shard open."""
    for path in files:
        kind, reader, src = open_shard(path)
        try:
            if kind == 'file':
                for i in range(reader.num_record_batches):
                    yield reader.get_batch(i)
            else:
                for batch in reader:
                    yield batch
        finally:
            src.close()


def count_rows(files):
    total = 0
    for path in files:
        kind, reader, src = open_shard(path)
        try:
            if kind == 'file':
                total += sum(reader.get_batch(i).num_rows
                             for i in range(reader.num_record_batches))
            else:
                total += sum(b.num_rows for b in reader)
        finally:
            src.close()
    return total


def create_table(conn):
    conn.executescript('''
        DROP TABLE IF EXISTS goodreads_fts;
        DROP TABLE IF EXISTS goodreads_books;
        CREATE TABLE goodreads_books (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            title            TEXT,
            author           TEXT,
            star_rating      REAL,
            num_ratings      INTEGER,
            num_reviews      INTEGER,
            summary          TEXT,
            genres           TEXT,
            first_published  TEXT,
            goodreads_url    TEXT
        );
        CREATE INDEX idx_goodreads_title ON goodreads_books(title);
        CREATE INDEX idx_goodreads_author ON goodreads_books(author);
    ''')
    conn.commit()


def build_fts(conn):
    t0 = time.time()
    print('Building FTS5 search index (this takes several minutes)...', flush=True)
    conn.executescript('''
        DROP TABLE IF EXISTS goodreads_fts;
        CREATE VIRTUAL TABLE goodreads_fts USING fts5(
            title, author, genres, summary,
            content='goodreads_books',
            tokenize='porter unicode61'
        );
        INSERT INTO goodreads_fts(rowid, title, author, genres, summary)
        SELECT id, title, author, genres, summary
        FROM goodreads_books
        WHERE title IS NOT NULL;
    ''')
    conn.commit()
    print(f'FTS5 index built in {time.time() - t0:.1f}s', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fresh', action='store_true',
                        help='drop goodreads_books and re-import from scratch')
    parser.add_argument('--rebuild-fts', action='store_true',
                        help='rebuild the FTS5 index after importing')
    parser.add_argument('--no-fts', action='store_true',
                        help='skip building the FTS5 index')
    parser.add_argument('--db', default=DB_PATH,
                        help=f'target SQLite file (default: {DB_PATH})')
    parser.add_argument('--limit', type=int, default=0,
                        help='stop after importing this many rows (for testing)')
    args = parser.parse_args()

    db_path = args.db
    print(f' Database: {db_path}')
    if not os.path.exists(db_path):
        print(' Error: database file does not exist. Start the server once to create it.')
        return 1

    files = sorted(glob.glob(CACHE_GLOB))
    if not files:
        print(f' Error: no cached Arrow shards found under {CACHE_GLOB}')
        print(' Run the original huggingface download once, e.g.:')
        print('   python -c "from datasets import load_dataset; load_dataset(\'BrightData/Goodreads-Books\')"')
        return 1

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    has_table = cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='goodreads_books'"
    ).fetchone()

    if args.fresh and has_table:
        print(' --fresh: dropping existing goodreads_books table')
        create_table(conn)
        has_table = True

    if not has_table:
        create_table(conn)

    start = cur.execute(
        "SELECT seq FROM sqlite_sequence WHERE name='goodreads_books'"
    ).fetchone()
    start = start[0] if start and start[0] else 0
    existing = cur.execute('SELECT COUNT(*) FROM goodreads_books').fetchone()[0]

    total = count_rows(files)
    print(f' Arrow shards:   {len(files)}')
    print(f' Dataset rows:   {total:,}')
    print(f' Already stored: {existing:,}\n')

    if existing >= total:
        print(' Import already complete.')
    else:
        print(f' Importing rows {existing + 1:,} - {total:,} '
              f'({total - existing:,} remaining)\n')

        ceiling = total if args.limit <= 0 else min(total, start + args.limit)
        offset = 0
        pending = []
        inserted = 0
        errors = 0
        t0 = time.time()

        def flush(force=False):
            nonlocal inserted
            if not pending or (not force and len(pending) < BATCH_ROWS):
                return
            cur.executemany(INSERT, pending)
            conn.commit()
            inserted += len(pending)
            done = offset + len(pending)
            rate = inserted / max(time.time() - t0, 0.001)
            eta = (max(total, ceiling) - done) / max(rate, 0.001)
            print(f'    {done:,} / {total:,}  ({done / total * 100:.1f}%)  '
                  f'errors={errors:,}  {rate:,.0f} rows/s  eta={eta / 60:.1f}m',
                  flush=True)
            pending.clear()

        stop = False
        for batch in iter_batches(files):
            n = batch.num_rows
            if offset >= ceiling:
                break
            if offset + n > start:
                sub = batch.slice(max(0, start - offset))
                room = ceiling - offset - max(0, start - offset)
                if room <= 0:
                    break
                if sub.num_rows > room:
                    sub = sub.slice(0, room)
                data = {c: sub.column(c).to_pylist() for c in COLUMNS}
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
            offset += min(n, max(0, ceiling - offset))
            flush(force=True)
            if offset >= ceiling:
                stop = True
                break

        flush(force=True)
        print(f'\n Rows added this run: {inserted:,}  errors: {errors:,}')
        if stop and ceiling < total:
            print(f' Stopped early at {ceiling:,} rows (--limit). Re-run without --limit to continue.')

    final_count = cur.execute('SELECT COUNT(*) FROM goodreads_books').fetchone()[0]
    print('=' * 46)
    print(' IMPORT COMPLETE')
    print(f'   Total rows: {final_count:,}')
    print('=' * 46)

    if args.rebuild_fts or (not args.no_fts and args.fresh):
        build_fts(conn)
    elif not args.no_fts:
        indexed = cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='goodreads_fts'"
        ).fetchone()
        if not indexed:
            build_fts(conn)
        else:
            print(' FTS5 index already present (use --rebuild-fts to force).')

    conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
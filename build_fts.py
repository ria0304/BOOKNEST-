import sqlite3
import time
import os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bookhaven.db')

conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

books = cur.execute('SELECT COUNT(*) FROM goodreads_books').fetchone()[0]
print(f" goodreads_books rows: {books:,}", flush=True)

t0 = time.time()
cur.execute('DROP TABLE IF EXISTS goodreads_fts')
cur.execute(
    "CREATE VIRTUAL TABLE goodreads_fts USING fts5("
    "title, author, genres, summary, content='goodreads_books', "
    "tokenize='porter unicode61')"
)
print(" created goodreads_fts", flush=True)

cur.execute(
    'INSERT INTO goodreads_fts(rowid, title, author, genres, summary) '
    'SELECT id, title, author, genres, summary FROM goodreads_books '
    'WHERE title IS NOT NULL'
)
conn.commit()

indexed = cur.execute('SELECT COUNT(*) FROM goodreads_fts').fetchone()[0]
print(f" indexed rows: {indexed:,}", flush=True)
print(f" elapsed: {time.time() - t0:.1f}s", flush=True)
conn.close()
print("FTS BUILD COMPLETE", flush=True)
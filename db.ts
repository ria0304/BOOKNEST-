import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Use process.cwd() instead of import.meta.url for Docker compatibility
const dbPath = path.join(process.cwd(), 'bookhaven.db');
const db = new Database(dbPath);

// ==================== SCHEMA ====================

db.exec(`
  -- Users
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT,
    gender TEXT,
    birthday TEXT,
    onboarded INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Books (master table)
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT,
    cover_url TEXT,
    open_library_id TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- User Books (library)
  CREATE TABLE IF NOT EXISTS user_books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    book_id INTEGER NOT NULL,
    status TEXT DEFAULT 'want_to_read',
    rating INTEGER,
    notes TEXT,
    mood TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (book_id) REFERENCES books(id),
    UNIQUE(user_id, book_id)
  );

  -- User Preferences
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER PRIMARY KEY,
    favorite_genres TEXT,
    reading_frequency TEXT,
    preferred_mood TEXT,
    favorite_types TEXT,
    current_obsession TEXT,
    last_mood TEXT,
    last_mood_updated DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Uploaded Books (Vault)
  CREATE TABLE IF NOT EXISTS uploaded_books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_size INTEGER,
    file_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Reading Sessions
  CREATE TABLE IF NOT EXISTS reading_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    book_id INTEGER,
    uploaded_book_id INTEGER,
    session_start DATETIME DEFAULT CURRENT_TIMESTAMP,
    session_end DATETIME,
    pages_read INTEGER,
    duration_minutes INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (book_id) REFERENCES books(id),
    FOREIGN KEY (uploaded_book_id) REFERENCES uploaded_books(id)
  );

  -- Goodreads Books
  CREATE TABLE IF NOT EXISTS goodreads_books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    author TEXT,
    star_rating REAL,
    num_ratings INTEGER,
    num_reviews INTEGER,
    summary TEXT,
    genres TEXT,
    first_published INTEGER,
    goodreads_url TEXT
  );
`);

// Create indexes
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_user_books_user_id ON user_books(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_books_status ON user_books(status);
  CREATE INDEX IF NOT EXISTS idx_reading_sessions_user_id ON reading_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_uploaded_books_user_id ON uploaded_books(user_id);
`);

// ==================== FTS5 VIRTUAL TABLE FOR GOODREADS ====================
try {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='goodreads_books'"
  ).get();

  if (tableExists) {
    db.exec(`
      DROP TABLE IF EXISTS goodreads_fts;
      CREATE VIRTUAL TABLE IF NOT EXISTS goodreads_fts 
      USING fts5(title, author, genres, summary, content='goodreads_books', 
                 tokenize='porter unicode61');
      INSERT INTO goodreads_fts(rowid, title, author, genres, summary)
      SELECT id, title, author, genres, summary FROM goodreads_books 
      WHERE title IS NOT NULL;
    `);
    console.log('✅ Goodreads FTS5 index created');
  }
} catch (err) {
  console.error('Could not create Goodreads FTS index:', err);
}

export default db;

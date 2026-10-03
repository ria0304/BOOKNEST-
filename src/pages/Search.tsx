import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search as SearchIcon, Plus, Check, ExternalLink, BookOpen, X, Star, Info, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { apiFetch } from '../lib/api';

type SearchType = 'all' | 'book' | 'author' | 'genre';

const SOURCES = [
  { id: 'goodreads', label: 'Goodreads', icon: '⭐', description: '6.4M books with summaries' },
  { id: 'google', label: 'Google Books', icon: '📚', description: 'Preview available' },
  { id: 'openlibrary', label: 'Open Library', icon: '📖', description: 'Free public domain' },
];

const SEARCH_TYPES: { value: SearchType; label: string; icon: string }[] = [
  { value: 'all', label: 'All', icon: '🔍' },
  { value: 'book', label: 'Book', icon: '📖' },
  { value: 'author', label: 'Author', icon: '✍️' },
  { value: 'genre', label: 'Genre', icon: '🎭' },
];

const CATEGORIES = ['Fantasy', 'Sci-Fi', 'Romance', 'Mystery', 'Non-Fiction'];

interface BookResult {
  key: string;
  title: string;
  author?: string;
  author_name?: string[];
  cover_url?: string;
  source?: string;
  url?: string;
  description?: string;
  rating?: number;
  ratings_count?: number;
  num_reviews?: number;
  published_date?: string;
  page_count?: number;
  genres?: string;
  categories?: string[];
  preview_link?: string;
  read_link?: string;
}

const stripHtml = (html: string): string => {
  if (!html) return '';
  let text = html.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<p[^>]*>/gi, '');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<div[^>]*>/gi, '');
  text = text.replace(/<[^>]*>/g, '');
  return text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .trim();
};

const authorLabel = (book: BookResult): string =>
  book.author || book.author_name?.join(', ') || 'Unknown Author';

const isNonEnglish = (text: string) => /[\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/.test(text);

const isEnglishText = (text: string) => {
  if (!text) return false;
  const letters = text.replace(/[^a-zA-Z]/g, '').length;
  return letters / text.length > 0.5;
};

const buildSearchUrl = (query: string, type: SearchType, source: string) => {
  const params = new URLSearchParams();
  params.set('q', query);
  if (type !== 'all') params.set('type', type);
  if (source !== 'goodreads') params.set('source', source);
  return `/search?${params.toString()}`;
};

export default function Search() {
  const location = useLocation();
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<SearchType>('all');
  const [activeSource, setActiveSource] = useState<string>('goodreads');
  const [results, setResults] = useState<BookResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [searchAttempted, setSearchAttempted] = useState(false);
  const [addedBooks, setAddedBooks] = useState<Set<string>>(new Set());
  const [brokenCovers, setBrokenCovers] = useState<Set<string>>(new Set());
  const [selectedBook, setSelectedBook] = useState<BookResult | null>(null);
  const [bookDetails, setBookDetails] = useState<BookResult | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Only the newest in-flight search is allowed to commit its results.
  const searchIdRef = useRef(0);

  const markCoverBroken = useCallback((key: string) => {
    setBrokenCovers(prev => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  const runSearch = useCallback(async (rawQuery: string, type: SearchType, source: string) => {
    const q = rawQuery.trim();
    if (!q) return;

    const requestId = ++searchIdRef.current;
    setLoading(true);
    setErrorMsg(null);
    setWarnings([]);
    setSearchAttempted(true);
    setResults([]);
    setBrokenCovers(new Set());

    try {
      let allResults: BookResult[] = [];

      if (source === 'goodreads' || source === 'all') {
        try {
          const response = await apiFetch(
            `/api/books/goodreads-search?q=${encodeURIComponent(q)}&limit=50&type=${type}`
          );
          if (response.success && response.results) {
            allResults = response.results.map((book: BookResult) => ({
              ...book,
              description: book.description && book.description !== 'No summary available'
                ? stripHtml(book.description)
                : '',
              author_name: book.author_name || [authorLabel(book)],
              source: 'Goodreads',
            }));
          }
        } catch (err) {
          console.error('Goodreads search error:', err);
        }
      }

      const needsFallback =
        allResults.length === 0 && (source === 'all' || source === 'google' || source === 'openlibrary');
      if (needsFallback) {
        try {
          const fallbackSource = source === 'all' ? 'all' : source;
          const fallbackResponse = await apiFetch(
            `/api/books/search?q=${encodeURIComponent(q)}&source=${fallbackSource}`
          );
          if (fallbackResponse.success && fallbackResponse.results) {
            allResults = fallbackResponse.results.map((book: BookResult) => ({
              ...book,
              description: book.description ? stripHtml(book.description) : '',
              author_name: book.author_name || [authorLabel(book)],
            }));
          }
        } catch (err) {
          console.error('Fallback search error:', err);
        }
      }

      if (requestId !== searchIdRef.current) return;

      setResults(allResults);
      if (allResults.length === 0) {
        setErrorMsg('No books found. Try a different search term or source.');
        setTimeout(() => setErrorMsg(null), 3000);
      }
    } catch (error) {
      if (requestId !== searchIdRef.current) return;
      console.error('Search failed:', error);
      setErrorMsg('Search failed. Please try again.');
      setTimeout(() => setErrorMsg(null), 3000);
    } finally {
      if (requestId === searchIdRef.current) setLoading(false);
    }
  }, []);

  // The URL fully describes the search, so there is exactly one code path that
  // performs a search: no stale closures, no duplicate fetches, and a shared
  // link reproduces exactly what the user saw.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const q = params.get('q');
    if (!q) return;

    const rawType = params.get('type');
    const type: SearchType = rawType && SEARCH_TYPES.some(t => t.value === rawType)
      ? rawType as SearchType
      : 'all';
    const rawSource = params.get('source');
    const source = rawSource && SOURCES.some(s => s.id === rawSource) ? rawSource : 'goodreads';

    setQuery(q);
    setSearchType(type);
    setActiveSource(source);
    void runSearch(q, type, source);
  }, [location.search, runSearch]);

  const searchBooks = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    // Submitting only updates the URL; the effect above runs the search.
    navigate(buildSearchUrl(q, searchType, activeSource));
  };

  const changeSource = (source: string) => {
    setActiveSource(source);
    const q = query.trim();
    if (!q) return;
    navigate(buildSearchUrl(q, searchType, source));
  };

  const addToLibrary = async (book: BookResult) => {
    setErrorMsg(null);
    try {
      await apiFetch('/api/library', {
        method: 'POST',
        body: JSON.stringify({
          title: book.title,
          author: authorLabel(book),
          cover_url: book.cover_url || '',
          open_library_id: book.key,
          status: 'want_to_read',
        }),
      });
      setAddedBooks(prev => new Set(prev).add(book.key));
      setErrorMsg(`"${book.title}" added to your library!`);
      setTimeout(() => setErrorMsg(null), 3000);
    } catch (error: any) {
      console.error('Failed to add book', error);
      const already = error.message.includes('Already in library');
      if (already) setAddedBooks(prev => new Set(prev).add(book.key));
      setErrorMsg(already
        ? `"${book.title}" is already in your library!`
        : 'Failed to add book. Please try again.');
      setTimeout(() => setErrorMsg(null), 3000);
    }
  };

  const fetchBookDetails = async (book: BookResult) => {
    setLoadingDetails(true);
    setSelectedBook(book);
    setBookDetails(book);
    try {
      if (book.key && book.source === 'Google Books') {
        const response = await apiFetch(`/api/books/details/${book.key}?source=google`);
        if (response.success && response.details) {
          const volume = response.details.volumeInfo || {};
          let description = volume.description || book.description || '';
          description = stripHtml(description);
          if (isNonEnglish(description) || !isEnglishText(description)) description = '';
          setBookDetails({
            ...book,
            description: description || 'No description available.',
            rating: volume.averageRating ?? book.rating,
            ratings_count: volume.ratingsCount ?? book.ratings_count,
            published_date: volume.publishedDate || book.published_date,
            page_count: volume.pageCount ?? book.page_count,
            categories: volume.categories || book.categories,
            preview_link: volume.previewLink,
            read_link: volume.infoLink,
            publisher: volume.publisher,
          } as BookResult);
        }
      }
    } catch (error) {
      console.error('Failed to fetch book details', error);
    } finally {
      setLoadingDetails(false);
    }
  };

  const closeDetails = () => {
    setSelectedBook(null);
    setBookDetails(null);
  };

  const coverSrc = (book: BookResult) =>
    book.cover_url && !brokenCovers.has(book.key) ? book.cover_url : null;

  return (
    <div className="max-w-6xl mx-auto">
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-pink-400 mb-4">
          Discover New Worlds
        </h1>
        <p className="text-gray-400">Search 6.4 million books with summaries from Goodreads</p>
        <p className="text-xs text-gray-500 mt-2">Powered by DRPA — Dynamic Reading Preference Algorithm</p>
      </div>

      {/* Source Selector */}
      <div className="flex justify-center gap-3 mb-6 flex-wrap">
        {SOURCES.map(source => (
          <button
            key={source.id}
            onClick={() => changeSource(source.id)}
            aria-pressed={activeSource === source.id}
            className={`px-5 py-2 rounded-xl text-sm font-medium transition-all ${
              activeSource === source.id
                ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-lg shadow-pink-500/25'
                : 'bg-purple-900/30 text-gray-400 hover:text-white hover:bg-purple-900/50'
            }`}
          >
            <span className="mr-1">{source.icon}</span>
            {source.label}
            <span className="ml-1 text-xs opacity-75 hidden md:inline">{source.description}</span>
          </button>
        ))}
      </div>

      {errorMsg && (
        <div className={`max-w-2xl mx-auto mb-6 px-4 py-3 rounded-lg text-center ${
          errorMsg.includes('added')
            ? 'bg-green-900/50 border border-green-500/50 text-green-200'
            : errorMsg.includes('already')
            ? 'bg-yellow-900/50 border border-yellow-500/50 text-yellow-200'
            : errorMsg.includes('No books found')
            ? 'bg-yellow-900/50 border border-yellow-500/50 text-yellow-200'
            : 'bg-red-900/50 border border-red-500/50 text-red-200'
        }`}>
          {errorMsg.includes('No books found') && <AlertCircle className="w-4 h-4 inline mr-2" />}
          {errorMsg}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="max-w-2xl mx-auto mb-4 px-4 py-2 rounded-lg text-center text-xs bg-yellow-900/30 border border-yellow-700/40 text-yellow-200">
          {warnings.join(' · ')} — results may be incomplete.
        </div>
      )}

      <form onSubmit={searchBooks} className="relative max-w-2xl mx-auto mb-6">
        <SearchIcon className="absolute left-4 top-1/2 transform -translate-y-1/2 text-purple-400 w-5 h-5" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for books, authors, or genres..."
          className="w-full bg-purple-950/30 border border-purple-900/50 rounded-full py-4 pl-12 pr-32 text-white placeholder-gray-500 focus:outline-none focus:border-pink-500 transition-colors"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="absolute right-2 top-1/2 transform -translate-y-1/2 bg-gradient-to-r from-purple-600 to-pink-600 text-white px-6 py-2 rounded-full font-medium hover:from-purple-500 hover:to-pink-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-pink-500/25"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      <div className="flex justify-center gap-2 mb-12 flex-wrap">
        {SEARCH_TYPES.map(t => (
          <button
            key={t.value}
            onClick={() => setSearchType(t.value)}
            aria-pressed={searchType === t.value}
            className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
              searchType === t.value
                ? 'bg-pink-600/80 text-white'
                : 'bg-purple-900/30 text-gray-400 hover:text-white hover:bg-purple-900/50'
            }`}
          >
            <span className="mr-1">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-pink-500" />
        </div>
      )}

      {!loading && searchAttempted && results.length === 0 && !errorMsg && (
        <div className="text-center py-20 bg-purple-950/10 rounded-2xl border border-purple-900/30 border-dashed">
          <BookOpen className="w-16 h-16 text-purple-800 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-gray-300 mb-2">No books found</h3>
          <p className="text-gray-500">Try a different search term, type, or source.</p>
        </div>
      )}

      {!loading && results.length > 0 && (
        <>
          <p className="text-sm text-gray-500 mb-4 text-center">
            {results.length} result{results.length === 1 ? '' : 's'} found
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6">
            {results.map((book, idx) => {
              const added = addedBooks.has(book.key);
              const src = coverSrc(book);
              return (
                <motion.div
                  key={book.key}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(idx, 12) * 0.04 }}
                  className="group flex flex-col"
                >
                  <div className="relative w-full aspect-[2/3] bg-purple-900/20 rounded-xl overflow-hidden border border-purple-900/50 group-hover:border-pink-500/50 transition-colors">
                    {src ? (
                      <img
                        src={src}
                        alt={book.title}
                        loading="lazy"
                        onError={() => markCoverBroken(book.key)}
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-purple-700">
                        <BookOpen className="w-10 h-10 opacity-50" />
                      </div>
                    )}

                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <button
                        onClick={() => addToLibrary(book)}
                        disabled={added}
                        className="bg-pink-600 hover:bg-pink-500 text-white p-2 rounded-full transform hover:scale-110 transition-all disabled:opacity-50 disabled:hover:scale-100 disabled:bg-green-600"
                        title={added ? 'Added to Library' : 'Add to Library'}
                      >
                        {added ? <Check className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>

                  <h3 className="text-sm font-medium text-white mt-3 line-clamp-2" title={book.title}>
                    {book.title}
                  </h3>
                  <p className="text-xs text-gray-400 line-clamp-1">{authorLabel(book)}</p>

                  {book.rating != null && (
                    <div className="flex items-center gap-1 mt-1">
                      <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
                      <span className="text-xs text-gray-400">{Number(book.rating).toFixed(1)}</span>
                      {book.ratings_count != null && (
                        <span className="text-xs text-gray-600">
                          ({book.ratings_count.toLocaleString()})
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-3 mt-2">
                    <button
                      onClick={() => fetchBookDetails(book)}
                      className="text-xs text-purple-400 hover:text-pink-400 transition-colors inline-flex items-center gap-1"
                    >
                      <Info className="w-3 h-3" /> Details
                    </button>
                    {book.url && (
                      <a
                        href={book.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-gray-500 hover:text-pink-400 transition-colors inline-flex items-center gap-1"
                      >
                        <ExternalLink className="w-3 h-3" /> Source
                      </a>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </div>
        </>
      )}

      {!searchAttempted && !loading && (
        <div className="mt-16">
          <h3 className="text-center text-sm text-gray-500 uppercase tracking-widest mb-6">
            Browse by category
          </h3>
          <div className="flex justify-center gap-3 flex-wrap">
            {CATEGORIES.map((category, idx) => (
              <button
                key={category}
                onClick={() => {
                  setQuery(category);
                  navigate(buildSearchUrl(category, 'genre', activeSource));
                }}
                className="px-5 py-2 rounded-xl text-sm bg-purple-900/30 border border-purple-800/50 text-gray-300 hover:border-pink-500/70 hover:text-white transition-all"
              >
                {category}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Book Details Modal */}
      <AnimatePresence>
        {selectedBook && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={closeDetails}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={e => e.stopPropagation()}
              className="bg-purple-950/90 border border-purple-800/50 rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-6 relative"
            >
              <button
                onClick={closeDetails}
                className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors"
                aria-label="Close details"
              >
                <X className="w-5 h-5" />
              </button>

              <div className="flex flex-col sm:flex-row gap-6">
                {coverSrc(bookDetails || selectedBook) && (
                  <img
                    src={coverSrc(bookDetails || selectedBook)!}
                    alt={selectedBook.title}
                    onError={() => markCoverBroken(selectedBook.key)}
                    className="w-full sm:w-40 aspect-[2/3] object-cover rounded-lg"
                    referrerPolicy="no-referrer"
                  />
                )}

                <div className="flex-1 min-w-0">
                  <h2 className="text-2xl font-bold text-white mb-1 pr-8">{selectedBook.title}</h2>
                  <p className="text-gray-400 mb-3">{authorLabel(selectedBook)}</p>

                  {loadingDetails ? (
                    <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-pink-500 mt-4" />
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-4 text-sm text-gray-400 mb-4">
                        {bookDetails?.rating != null && (
                          <span className="inline-flex items-center gap-1">
                            <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
                            {Number(bookDetails.rating).toFixed(1)}
                            {bookDetails.ratings_count != null &&
                              ` (${bookDetails.ratings_count.toLocaleString()} ratings)`}
                          </span>
                        )}
                        {bookDetails?.num_reviews != null && (
                          <span>{bookDetails.num_reviews.toLocaleString()} reviews</span>
                        )}
                        {bookDetails?.published_date && <span>{bookDetails.published_date}</span>}
                        {bookDetails?.page_count != null && <span>{bookDetails.page_count} pages</span>}
                      </div>

                      {bookDetails?.description && (
                        <p className="text-sm text-gray-300 leading-relaxed mb-4 whitespace-pre-line">
                          {bookDetails.description}
                        </p>
                      )}

                      {bookDetails?.genres && (
                        <p className="text-xs text-gray-500 mb-4">
                          <span className="uppercase tracking-wider text-gray-600">Genres: </span>
                          {bookDetails.genres}
                        </p>
                      )}

                      {bookDetails?.categories && bookDetails.categories.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-4">
                          {bookDetails.categories.slice(0, 6).map(category => (
                            <span
                              key={category}
                              className="px-2 py-1 rounded-full text-xs bg-purple-900/40 border border-purple-800/50 text-gray-300"
                            >
                              {category}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-wrap gap-3">
                        <button
                          onClick={() => addToLibrary(selectedBook)}
                          disabled={addedBooks.has(selectedBook.key)}
                          className="inline-flex items-center gap-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white px-5 py-2 rounded-full font-medium hover:from-purple-500 hover:to-pink-500 transition-all disabled:opacity-50 disabled:from-green-600 disabled:to-green-600"
                        >
                          {addedBooks.has(selectedBook.key)
                            ? <Check className="w-4 h-4" />
                            : <Plus className="w-4 h-4" />}
                          {addedBooks.has(selectedBook.key) ? 'In Library' : 'Add to Library'}
                        </button>
                        {bookDetails?.preview_link && (
                          <a
                            href={bookDetails.preview_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 bg-purple-900/40 border border-purple-800/50 text-gray-200 px-5 py-2 rounded-full font-medium hover:border-pink-500/70 transition-all"
                          >
                            <ExternalLink className="w-4 h-4" /> Preview
                          </a>
                        )}
                        {selectedBook.url && (
                          <a
                            href={selectedBook.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 bg-purple-900/40 border border-purple-800/50 text-gray-200 px-5 py-2 rounded-full font-medium hover:border-pink-500/70 transition-all"
                          >
                            <ExternalLink className="w-4 h-4" /> View Source
                          </a>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
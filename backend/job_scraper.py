"""
Job scraper that fetches and parses job listings from the
speedyapply/2026-SWE-College-Jobs GitHub repository README.
Stores results in a local SQLite database.
"""

import re
import sqlite3
import logging
from datetime import datetime, timedelta
from pathlib import Path

import httpx

logger = logging.getLogger('job-scraper')

DB_PATH = Path(__file__).parent / 'jobs.db'

README_URLS = {
    'internship': 'https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main/README.md',
    'new_grad': 'https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main/NEW_GRAD_USA.md',
}


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def init_db():
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company TEXT NOT NULL,
            position TEXT NOT NULL,
            location TEXT,
            salary TEXT,
            apply_url TEXT,
            age TEXT,
            category TEXT,
            source TEXT,
            date_added TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company, position, apply_url)
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS scrape_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scraped_at TEXT DEFAULT CURRENT_TIMESTAMP,
            job_count INTEGER,
            source TEXT
        )
    ''')
    conn.commit()
    conn.close()


def strip_html(text: str) -> str:
    """Remove all HTML tags from a string, keeping only the text content."""
    return re.sub(r'<[^>]+>', '', text).strip()


def parse_apply_url(cell: str) -> str:
    """Extract the apply URL from the HTML <a href="..."> in the Posting column."""
    match = re.search(r'href="([^"]+)"', cell)
    return match.group(1) if match else ''


def parse_markdown_table(text: str, category: str, source: str) -> list[dict]:
    """Parse a markdown table section and return a list of job dicts."""
    jobs = []
    lines = text.strip().split('\n')

    # Find table rows (lines starting with |)
    table_lines = [l for l in lines if l.strip().startswith('|')]
    if len(table_lines) < 2:
        return jobs

    # Parse header
    header = [h.strip().lower() for h in table_lines[0].split('|')[1:-1]]

    # Skip separator row (second line with dashes)
    for row_line in table_lines[2:]:
        cells = [c.strip() for c in row_line.split('|')[1:-1]]
        if len(cells) < len(header):
            continue

        row = dict(zip(header, cells))

        company = strip_html(row.get('company', ''))
        position = strip_html(row.get('position', ''))
        location = strip_html(row.get('location', ''))
        salary = strip_html(row.get('salary', ''))
        posting = row.get('posting', '')
        age = row.get('age', '').strip()

        if not company or not position:
            continue

        apply_url = parse_apply_url(posting)

        jobs.append({
            'company': company,
            'position': position,
            'location': location,
            'salary': salary if salary else None,
            'apply_url': apply_url,
            'age': age,
            'category': category,
            'source': source,
        })

    return jobs


def extract_tables_from_readme(markdown: str, source: str) -> list[dict]:
    """Extract all job tables from a README, with category labels."""
    all_jobs = []

    # Split by headings to identify sections
    sections = re.split(r'^(#{1,4}\s+.+)$', markdown, flags=re.MULTILINE)

    current_category = 'other'
    for i, section in enumerate(sections):
        heading_match = re.match(r'^#{1,4}\s+(.+)', section.strip())
        if heading_match:
            heading_text = heading_match.group(1).strip().lower()
            if 'faang' in heading_text:
                current_category = 'faang+'
            elif 'quant' in heading_text:
                current_category = 'quant'
            elif 'new grad' in heading_text or 'new_grad' in heading_text:
                current_category = 'new_grad'
            elif 'intern' in heading_text:
                current_category = 'internship'
            elif 'other' in heading_text:
                current_category = 'other'
            continue

        # Try to parse tables from this section
        if '|' in section:
            jobs = parse_markdown_table(section, current_category, source)
            all_jobs.extend(jobs)

    return all_jobs


async def fetch_and_store_jobs() -> dict:
    """Fetch job listings from GitHub and store in SQLite. Returns stats."""
    init_db()
    total_new = 0
    total_updated = 0
    total_fetched = 0

    async with httpx.AsyncClient(timeout=30) as client:
        for source_name, url in README_URLS.items():
            try:
                resp = await client.get(url)
                resp.raise_for_status()
                markdown = resp.text

                jobs = extract_tables_from_readme(markdown, source_name)
                total_fetched += len(jobs)

                conn = get_db()
                for job in jobs:
                    try:
                        conn.execute('''
                            INSERT INTO jobs (company, position, location, salary, apply_url, age, category, source)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ''', (
                            job['company'], job['position'], job['location'],
                            job['salary'], job['apply_url'], job['age'],
                            job['category'], job['source'],
                        ))
                        total_new += 1
                    except sqlite3.IntegrityError:
                        # Update existing row
                        conn.execute('''
                            UPDATE jobs SET location=?, salary=?, age=?, category=?, date_added=CURRENT_TIMESTAMP
                            WHERE company=? AND position=? AND apply_url=?
                        ''', (
                            job['location'], job['salary'], job['age'], job['category'],
                            job['company'], job['position'], job['apply_url'],
                        ))
                        total_updated += 1

                conn.execute('''
                    INSERT INTO scrape_log (job_count, source) VALUES (?, ?)
                ''', (len(jobs), source_name))
                conn.commit()
                conn.close()

                logger.info(f'Fetched {len(jobs)} jobs from {source_name}')

            except Exception as e:
                logger.error(f'Error fetching {source_name}: {e}')

    return {
        'fetched': total_fetched,
        'new': total_new,
        'updated': total_updated,
    }


def get_all_jobs(search: str = '', category: str = '') -> list[dict]:
    """Retrieve jobs from the database with optional filtering."""
    init_db()
    conn = get_db()

    query = 'SELECT * FROM jobs WHERE 1=1'
    params = []

    if search:
        query += ' AND (company LIKE ? OR position LIKE ? OR location LIKE ?)'
        term = f'%{search}%'
        params.extend([term, term, term])

    if category:
        query += ' AND category = ?'
        params.append(category)

    query += ' ORDER BY date_added DESC'

    rows = conn.execute(query, params).fetchall()
    conn.close()

    return [dict(row) for row in rows]


def get_job_stats() -> dict:
    """Get summary statistics about the job database."""
    init_db()
    conn = get_db()

    total = conn.execute('SELECT COUNT(*) FROM jobs').fetchone()[0]
    by_category = {}
    for row in conn.execute('SELECT category, COUNT(*) as cnt FROM jobs GROUP BY category'):
        by_category[row['category']] = row['cnt']

    last_scrape = conn.execute(
        'SELECT scraped_at, job_count FROM scrape_log ORDER BY id DESC LIMIT 1'
    ).fetchone()

    conn.close()

    return {
        'total': total,
        'by_category': by_category,
        'last_scrape': dict(last_scrape) if last_scrape else None,
    }

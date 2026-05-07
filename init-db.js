// init-db.js — Run once to create tables
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Content database: stores all processed articles + scripts
      CREATE TABLE IF NOT EXISTS content_items (
        id SERIAL PRIMARY KEY,
        article_url TEXT UNIQUE NOT NULL,
        article_title TEXT,
        quick_summary TEXT,
        hook TEXT,
        short_script TEXT,
        niche TEXT,
        source_feed TEXT,
        published_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Viral hooks library
      CREATE TABLE IF NOT EXISTS viral_hooks (
        id SERIAL PRIMARY KEY,
        hook_text TEXT NOT NULL,
        category TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Niche configurations
      CREATE TABLE IF NOT EXISTS niches (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        audience_psychographics TEXT,
        rss_feeds TEXT[],
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_content_url ON content_items(article_url);
      CREATE INDEX IF NOT EXISTS idx_content_niche ON content_items(niche);
      CREATE INDEX IF NOT EXISTS idx_hooks_category ON viral_hooks(category);
    `);

    // Seed some starter hooks if table is empty
    const { rows } = await client.query('SELECT COUNT(*) FROM viral_hooks');
    if (parseInt(rows[0].count) === 0) {
      console.log('Seeding viral hooks...');
      const hooks = [
        ["Stop scrolling — this changes everything", "urgency"],
        ["Nobody is talking about this", "curiosity"],
        ["This is your sign to", "inspiration"],
        ["I spent 100 hours researching so you don't have to", "authority"],
        ["Here's what [company] doesn't want you to know", "controversy"],
        ["Delete this app before it's too late", "fear"],
        ["The [industry] just changed forever", "breaking_news"],
        ["I was today years old when I learned", "surprise"],
        ["POV: You just discovered", "relatable"],
        ["If you're not using this yet, you're falling behind", "fomo"],
        ["This took me 5 minutes and saved me 5 hours", "efficiency"],
        ["You've been doing [task] wrong your entire life", "correction"],
        ["The internet is going crazy over this", "social_proof"],
        ["Wait for it…", "suspense"],
        ["Hot take:", "opinion"],
        ["Unpopular opinion:", "opinion"],
        ["This free tool replaces [expensive tool]", "value"],
        ["Watch me build this in under 60 seconds", "demo"],
        ["The secret [experts] use that nobody talks about", "insider"],
        ["I tested every [tool] so you don't have to", "authority"],
        ["This changes the game for [audience]", "breaking_news"],
        ["3 things I wish I knew before", "advice"],
        ["The biggest mistake [audience] make is", "correction"],
        ["Here's a hack that will save you hours", "efficiency"],
        ["Most people don't know this exists", "curiosity"],
        ["Breaking: [topic] just got a major update", "breaking_news"],
        ["I can't believe this is free", "value"],
        ["You need to see this before everyone else does", "fomo"],
        ["Forget everything you know about [topic]", "paradigm_shift"],
        ["What happens when you combine [A] and [B]", "curiosity"]
      ];
      for (const [text, cat] of hooks) {
        await client.query(
          'INSERT INTO viral_hooks (hook_text, category) VALUES ($1, $2)',
          [text, cat]
        );
      }
      console.log(`Seeded ${hooks.length} viral hooks.`);
    }

    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('DB init error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

initDB();

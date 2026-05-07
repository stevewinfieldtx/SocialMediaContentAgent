// server.js — Content Agent v2: Smart Wizard Flow
require('dotenv').config();
const express = require('express');
const Parser = require('rss-parser');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const rssParser = new Parser();

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL_ID = process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4-20250514';
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';
const SERPER_API_KEY = process.env.SERPER_API_KEY || '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

async function callLLM(systemPrompt, userPrompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL_ID,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`LLM error: ${JSON.stringify(data.error)}`);
  return data.choices?.[0]?.message?.content || '';
}

function parseLLMJson(raw) {
  const cleaned = raw.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(cleaned);
}

// ─────────────────────────────────────────────
// STEP 1: Scrape website with Firecrawl
// ─────────────────────────────────────────────

app.post('/api/analyze-site', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    let siteContent = '';

    if (FIRECRAWL_API_KEY) {
      const fcRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
        },
        body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      });
      const fcData = await fcRes.json();
      siteContent = fcData?.data?.markdown || fcData?.data?.content || '';
    }

    if (!siteContent) {
      try {
        const fallback = await fetch(url, { headers: { 'User-Agent': 'ContentAgent/1.0' } });
        const html = await fallback.text();
        siteContent = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 5000);
      } catch (e) {
        siteContent = `Website URL: ${url} (could not scrape)`;
      }
    }

    siteContent = siteContent.substring(0, 6000);

    const analysis = await callLLM(
      'You are a business analyst. Respond ONLY with valid JSON, no markdown.',
      `Analyze this website content and extract a business profile.

WEBSITE CONTENT:
${siteContent}

Respond with JSON:
{
  "company_name": "the company name",
  "business_summary": "2-3 sentence summary of what this company does, who they serve, and their value proposition",
  "industry": "primary industry",
  "target_audience": "who their customers are",
  "key_topics": ["list", "of", "5-8", "topics", "they", "cover"],
  "tone": "their communication style"
}`
    );

    const profile = parseLLMJson(analysis);
    res.json({ success: true, profile });
  } catch (err) {
    console.error('Site analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// STEP 2: Discover sources for niche + platform
// ─────────────────────────────────────────────

app.post('/api/discover-sources', async (req, res) => {
  const { niche, platforms, business_summary } = req.body;
  if (!niche) return res.status(400).json({ error: 'niche is required' });

  const results = {};

  for (const platform of (platforms || ['reddit'])) {
    try {
      if (platform === 'youtube' && YOUTUBE_API_KEY) {
        const ytRes = await fetch(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(niche)}&maxResults=10&order=relevance&key=${YOUTUBE_API_KEY}`
        );
        const ytData = await ytRes.json();
        const channelIds = (ytData.items || []).map(i => i.snippet.channelId).filter(Boolean);

        let channels = [];
        if (channelIds.length > 0) {
          const statsRes = await fetch(
            `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelIds.join(',')}&key=${YOUTUBE_API_KEY}`
          );
          const statsData = await statsRes.json();
          channels = (statsData.items || []).map(ch => ({
            name: ch.snippet.title,
            description: ch.snippet.description?.substring(0, 150),
            subscribers: parseInt(ch.statistics.subscriberCount) || 0,
            videos: parseInt(ch.statistics.videoCount) || 0,
            id: ch.id,
            url: `https://www.youtube.com/channel/${ch.id}`,
            rss_url: `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`,
            platform: 'youtube',
          }));
          channels.sort((a, b) => b.subscribers - a.subscribers);
        }
        results.youtube = channels;

      } else if (platform === 'reddit') {
        const llmPrompt = `What are the 10 best subreddits for someone in this niche: "${niche}"?
Business context: ${business_summary || 'Not provided'}
Respond with JSON: { "subreddits": [{ "name": "subredditname", "display": "r/subredditname", "description": "why relevant", "url": "https://www.reddit.com/r/subredditname/", "rss_url": "https://www.reddit.com/r/subredditname/.rss", "relevance": "high/medium" }] }`;

        if (SERPER_API_KEY) {
          const serpRes = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_API_KEY },
            body: JSON.stringify({ q: `best subreddits for ${niche} site:reddit.com`, num: 10 }),
          });
          const serpData = await serpRes.json();
          const searchContext = JSON.stringify(serpData.organic?.slice(0, 10)?.map(r => ({ title: r.title, snippet: r.snippet, link: r.link })));

          const llmRes = await callLLM(
            'You are a Reddit expert. Respond ONLY with valid JSON.',
            `${llmPrompt}\n\nSearch results for context:\n${searchContext}`
          );
          results.reddit = parseLLMJson(llmRes).subreddits || [];
        } else {
          const llmRes = await callLLM('You are a Reddit expert. Respond ONLY with valid JSON.', llmPrompt);
          results.reddit = parseLLMJson(llmRes).subreddits || [];
        }

      } else if (platform === 'news') {
        const keywords = encodeURIComponent(niche);
        results.news = [{
          name: `Google News: ${niche}`,
          description: `Latest news articles about ${niche}`,
          rss_url: `https://news.google.com/rss/search?q=${keywords}&hl=en-US&gl=US&ceid=US:en`,
          platform: 'news',
        }];

        if (SERPER_API_KEY) {
          const serpRes = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_API_KEY },
            body: JSON.stringify({ q: `${niche} latest news`, type: 'news', num: 10 }),
          });
          const serpData = await serpRes.json();
          const sources = [...new Set((serpData.news || []).map(n => n.source))];
          results.news_sources = sources.map(s => ({ name: s, platform: 'news' }));
        }

      } else if (platform === 'twitter') {
        const llmRes = await callLLM(
          'You are a social media expert. Respond ONLY with valid JSON.',
          `What are the 10 most influential Twitter/X accounts for this niche: "${niche}"?
Business context: ${business_summary || 'Not provided'}
Respond with JSON: { "accounts": [{ "handle": "@username", "name": "Display Name", "description": "why relevant", "url": "https://x.com/username", "relevance": "high/medium" }] }`
        );
        results.twitter = parseLLMJson(llmRes).accounts || [];
        results.twitter_note = "Twitter/X doesn't offer public RSS feeds. Use RSS.app to create feeds from these accounts.";
      }
    } catch (err) {
      console.error(`Error discovering ${platform}:`, err.message);
      results[platform] = { error: err.message };
    }
  }

  res.json({ success: true, sources: results });
});

// ─────────────────────────────────────────────
// STEP 3: Generate psychographic keywords
// ─────────────────────────────────────────────

app.post('/api/generate-psychographics', async (req, res) => {
  const { business_summary, niche, industry, target_audience } = req.body;

  try {
    const llmRes = await callLLM(
      'You are an audience research expert. Respond ONLY with valid JSON.',
      `Generate 20 audience psychographic keywords/phrases for this business and niche. These will be shown as checkboxes — short, clear phrases someone can scan and select.

Business: ${business_summary || 'Not provided'}
Niche: ${niche}
Industry: ${industry || 'Not provided'}
Current audience: ${target_audience || 'Not provided'}

Group them into 5 categories. Respond with JSON:
{
  "psychographics": [
    { "keyword": "short descriptive phrase", "category": "pain_points|motivations|behaviors|demographics|values", "description": "one-line explanation" }
  ]
}`
    );

    const data = parseLLMJson(llmRes);
    res.json({ success: true, psychographics: data.psychographics || [] });
  } catch (err) {
    console.error('Psychographics error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// STEP 4: Run the content agent
// ─────────────────────────────────────────────

async function isDuplicate(articleUrl) {
  const { rows } = await pool.query('SELECT id FROM content_items WHERE article_url = $1', [articleUrl]);
  return rows.length > 0;
}

async function getRandomHooks(limit = 10) {
  const { rows } = await pool.query('SELECT hook_text, category FROM viral_hooks ORDER BY RANDOM() LIMIT $1', [limit]);
  return rows;
}

async function processArticle(article, nicheConfig) {
  const { title, link, contentSnippet, pubDate } = article;

  if (await isDuplicate(link)) {
    return { skipped: true, reason: 'Already covered this topic', title };
  }

  const hooks = await getRandomHooks(15);
  const hookList = hooks.map(h => `- "${h.hook_text}" [${h.category}]`).join('\n');

  const evalRaw = await callLLM(
    'You are a JSON-only responder. Output only valid JSON.',
    `You are a content strategist for: "${nicheConfig.name}"
Description: ${nicheConfig.description}
Audience: ${nicheConfig.audience}

Evaluate this article:
Title: ${title} | Link: ${link} | Published: ${pubDate || 'Unknown'} | Snippet: ${contentSnippet || 'No snippet'}

Respond ONLY with JSON:
{ "relevant": true/false, "reason": "brief explanation", "search_query": "if relevant, a query to learn more" }`
  );

  let evaluation;
  try { evaluation = parseLLMJson(evalRaw); } catch (e) {
    return { skipped: true, reason: 'Could not evaluate', title };
  }

  if (!evaluation.relevant) {
    return { skipped: true, reason: evaluation.reason, title };
  }

  let enrichment = '';
  if (SERPER_API_KEY && evaluation.search_query) {
    try {
      const serpRes = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_API_KEY },
        body: JSON.stringify({ q: evaluation.search_query, num: 5 }),
      });
      const serpData = await serpRes.json();
      enrichment = (serpData.organic || []).map(r => `${r.title}: ${r.snippet}`).join('\n');
    } catch (e) { enrichment = ''; }
  }

  const scriptRaw = await callLLM(
    'You are a JSON-only responder. Output only valid JSON.',
    `You are a viral short-form content writer.
Niche: "${nicheConfig.name}" | Audience: ${nicheConfig.audience}

ARTICLE: ${title} — ${link}
Snippet: ${contentSnippet || 'N/A'}
Additional context: ${enrichment || 'None'}

HOOKS TO CHOOSE FROM:
${hookList}

Respond ONLY with JSON:
{
  "quick_summary": "2-3 sentence summary of why this matters",
  "hook": "Opening hook adapted from the list to fit this topic",
  "short_script": "50-75 word punchy script outline for a 30-60 second short"
}`
  );

  let script;
  try { script = parseLLMJson(scriptRaw); } catch (e) {
    return { skipped: true, reason: 'Could not generate script', title };
  }

  const item = {
    article_url: link, article_title: title,
    quick_summary: script.quick_summary, hook: script.hook, short_script: script.short_script,
    niche: nicheConfig.name, source_feed: article._feedUrl || '',
    published_at: pubDate ? new Date(pubDate) : null,
  };

  await pool.query(
    `INSERT INTO content_items (article_url, article_title, quick_summary, hook, short_script, niche, source_feed, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (article_url) DO NOTHING`,
    [item.article_url, item.article_title, item.quick_summary, item.hook, item.short_script, item.niche, item.source_feed, item.published_at]
  );

  return { skipped: false, ...item };
}

app.post('/api/run', async (req, res) => {
  const { feed_urls, niche_name, niche_description, audience_description, max_articles } = req.body;
  if (!feed_urls || feed_urls.length === 0) return res.status(400).json({ error: 'At least one feed URL required' });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured' });

  const nicheConfig = {
    name: niche_name || 'General',
    description: niche_description || 'General interest content',
    audience: audience_description || 'Curious professionals',
  };

  const allResults = [];
  const maxPerFeed = Math.ceil((max_articles || 10) / feed_urls.length);

  for (const feedUrl of feed_urls) {
    try {
      const feed = await rssParser.parseURL(feedUrl);
      const articles = feed.items.slice(0, maxPerFeed);
      for (const article of articles) {
        try {
          article._feedUrl = feedUrl;
          allResults.push(await processArticle(article, nicheConfig));
        } catch (err) {
          allResults.push({ skipped: true, reason: err.message, title: article.title });
        }
      }
    } catch (err) {
      allResults.push({ skipped: true, reason: `Feed error: ${err.message}`, title: feedUrl });
    }
  }

  res.json({
    total_articles: allResults.length,
    processed: allResults.filter(r => !r.skipped).length,
    skipped: allResults.filter(r => r.skipped).length,
    results: allResults,
  });
});

// CRUD endpoints
app.get('/api/content', async (req, res) => {
  const { niche, limit } = req.query;
  let q = 'SELECT * FROM content_items'; const p = [];
  if (niche) { q += ' WHERE niche = $1'; p.push(niche); }
  q += ' ORDER BY created_at DESC';
  if (limit) { q += ` LIMIT $${p.length + 1}`; p.push(parseInt(limit)); }
  const { rows } = await pool.query(q, p);
  res.json(rows);
});

app.get('/api/hooks', async (req, res) => {
  const { rows } = await pool.query('SELECT id, hook_text, category FROM viral_hooks ORDER BY category, id');
  res.json(rows);
});

app.post('/api/hooks', async (req, res) => {
  const { hook_text, category } = req.body;
  if (!hook_text) return res.status(400).json({ error: 'hook_text required' });
  await pool.query('INSERT INTO viral_hooks (hook_text, category) VALUES ($1, $2)', [hook_text, category || 'general']);
  res.json({ success: true });
});

app.delete('/api/hooks/:id', async (req, res) => {
  await pool.query('DELETE FROM viral_hooks WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.delete('/api/content/:id', async (req, res) => {
  await pool.query('DELETE FROM content_items WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', apis: {
      openrouter: !!OPENROUTER_API_KEY, firecrawl: !!FIRECRAWL_API_KEY,
      serper: !!SERPER_API_KEY, youtube: !!YOUTUBE_API_KEY,
    }});
  } catch (err) { res.status(500).json({ status: 'error', db: err.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Content Agent v2 running on port ${PORT}`));

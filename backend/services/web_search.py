"""Simple web search service for script generation.
Uses DuckDuckGo's HTML search (no API key needed)."""

import json
import urllib.parse
from typing import List, Optional

import httpx


async def web_search(query: str, max_results: int = 5) -> List[dict]:
    """Search the web for current information about a topic.
    
    Uses DuckDuckGo HTML search — no API key required.
    Returns list of {title, url, snippet} dicts.
    """
    url = "https://html.duckduckgo.com/html/"
    params = {"q": query}
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
    }
    
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            resp = await client.post(url, data=params, headers=headers)
            resp.raise_for_status()
            html = resp.text
    except Exception as e:
        return [{"title": "搜索失败", "url": "", "snippet": f"无法搜索: {e}"}]
    
    # Simple HTML parsing to extract search results
    results = []
    import re
    
    # Find result blocks
    blocks = re.findall(
        r'<a rel="nofollow" class="result__a" href="([^"]+)".*?>(.*?)</a>.*?'
        r'<a class="result__snippet"[^>]*>(.*?)</a>',
        html, re.DOTALL
    )
    
    for url_text, title_html, snippet_html in blocks[:max_results]:
        # Clean HTML tags
        title = re.sub(r'<[^>]+>', '', title_html).strip()
        snippet = re.sub(r'<[^>]+>', '', snippet_html).strip()
        # Decode HTML entities
        title = html.unescape(title) if hasattr(html, 'unescape') else title
        snippet = html.unescape(snippet) if hasattr(html, 'unescape') else snippet
        
        results.append({
            "title": title,
            "url": url_text,
            "snippet": snippet,
        })
    
    return results if results else [{"title": "无结果", "url": "", "snippet": "未找到相关搜索结果"}]


async def web_fetch_content(url: str, max_chars: int = 2000) -> str:
    """Fetch and extract text content from a URL."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            text = resp.text
    except Exception as e:
        return f"获取失败: {e}"
    
    # Simple text extraction — remove scripts, styles, tags
    import re
    text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL)
    text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    
    return text[:max_chars]

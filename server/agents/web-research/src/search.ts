export type WebSource = { title: string; url: string; excerpt: string };
export interface WebSearchProvider { search(query: string, maxResults: number): Promise<WebSource[]>; }

/** Public, keyless search endpoint. The returned URLs are always preserved as evidence. */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  public constructor(private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {}

  public async search(query: string, maxResults: number): Promise<WebSource[]> {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('skip_disambig', '1');
    const response = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}.`);
    const body = await response.json() as DuckDuckGoResponse;
    const flattened = flatten(body.RelatedTopics ?? []);
    if (body.AbstractURL && body.AbstractText) flattened.unshift({ FirstURL: body.AbstractURL, Text: body.AbstractText });
    const seen = new Set<string>();
    return flattened.flatMap((item) => toSource(item)).filter((item) => item !== undefined).filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    }).slice(0, maxResults);
  }
}

type Topic = { FirstURL?: string; Text?: string; Topics?: Topic[] };
type DuckDuckGoResponse = { AbstractURL?: string; AbstractText?: string; RelatedTopics?: Topic[] };
function flatten(topics: Topic[]): Topic[] { return topics.flatMap((topic) => topic.Topics ? flatten(topic.Topics) : [topic]); }
function toSource(topic: Topic): WebSource | undefined {
  if (!topic.FirstURL || !topic.Text) return undefined;
  try { const url = new URL(topic.FirstURL).toString(); return { title: topic.Text.slice(0, 160), url, excerpt: topic.Text }; } catch { return undefined; }
}

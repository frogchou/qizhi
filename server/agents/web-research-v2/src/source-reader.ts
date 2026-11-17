import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { BlockList, isIP } from 'node:net';

export type Candidate = { url: string; title: string; format: 'json' | 'html' | 'text' };
export type Page = { url: string; text: string; retrievedAt: string };
export type ReadPage = (candidate: Candidate) => Promise<Page>;

const reserved = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8],
  ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24], ['192.88.99.0',24],
  ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',3],
] as const) reserved.addSubnet(address, prefix);
export function publicURL(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hostname.endsWith('.') || !u.hostname.includes('.') || isIP(u.hostname)) throw new Error('仅接受公开 HTTPS 来源');
  u.hash = '';
  return u;
}

type Reply = { status: number; type: string; location?: string; body: string };
async function request(u: URL, signal: AbortSignal): Promise<Reply> {
  const records = await lookup(u.hostname, { all: true, family: 4 });
  if (!records.length || records.some(r => reserved.check(r.address))) throw new Error('来源地址不在公开网络范围内');
  // Pin the checked address while retaining hostname verification for TLS.
  return new Promise((resolve, reject) => {
    const req = get(u, { signal, family: 4, agent: false, lookup: (_host, _opts, cb) => cb(null, records[0].address, 4),
      headers: { 'User-Agent': 'Middleground-Research/2.0', Accept: 'application/geo+json, application/json, text/html, text/plain' } }, res => {
      const status = res.statusCode ?? 0;
      const meta = {status, type: String(res.headers['content-type'] ?? ''), location: res.headers.location};
      if (status < 200 || status >= 300) { res.destroy(); resolve({...meta,body:''}); return; }
      let size = 0;
      const parts: Buffer[] = [];
      res.on('error', reject);
      res.on('data', (part: Buffer) => {
        size += part.length;
        if (size > 4_000_000) { res.destroy(new Error('来源正文过大')); return; }
        parts.push(part);
      });
      res.on('end', () => resolve({...meta, body:Buffer.concat(parts).toString('utf8')}));
    });
    req.on('error', reject);
  });
}

export function readablePage(body: string, type: string, expected: Candidate['format']): string {
  const html = /html/i.test(type) || /^\s*<(?:!doctype\s+html|html)[\s>]/i.test(body);
  if (expected === 'json' && html) throw new Error('预期 JSON，来源返回 HTML');
  let text = body;
  if (expected === 'json' || /json/i.test(type)) {
    try { text = JSON.stringify(JSON.parse(body)); } catch { throw new Error('来源返回无效 JSON'); }
  } else if (html) {
    text = body.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&');
    if (/captcha|verify you are human|just a moment|access denied/i.test(text.slice(0,420))) throw new Error('来源返回验证页或拒绝访问');
  } else if (!/^text\/plain/i.test(type)) throw new Error('不支持的正文类型');
  text = text.replace(/\s+/g,' ').trim();
  if (text.length < 16) throw new Error('来源没有足够可读正文');
  return text.slice(0, 32_000);
}

export const readPage: ReadPage = async (candidate) => {
  const signal = AbortSignal.timeout(12_000);
  let url = publicURL(candidate.url);
  for (let hop = 0; hop <= 3; hop++) {
    const r = await request(url,signal);
    if ([301,302,303,307,308].includes(r.status) && r.location) {
      url = publicURL(new URL(r.location,url).href);
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw new Error('来源返回 HTTP ' + r.status);
    return {url:url.href, text:readablePage(r.body,r.type,candidate.format), retrievedAt:new Date().toISOString()};
  }
  throw new Error('来源重定向次数过多');
};

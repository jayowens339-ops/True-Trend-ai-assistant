// pages/api/robots.ts
import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const BASE = process.env.NEXT_PUBLIC_BASE_URL || 'https://trytruetrend.com';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // cache 1h
  res.send(
`User-agent: *
Allow: /

Sitemap: ${BASE}/sitemap.xml
`
  );
}

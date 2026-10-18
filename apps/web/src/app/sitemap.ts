import type { MetadataRoute } from 'next';

import { siteConfig } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteConfig.url, changeFrequency: 'weekly', priority: 1 },
    { url: `${siteConfig.url}/download`, changeFrequency: 'weekly', priority: 0.9 },
  ];
}

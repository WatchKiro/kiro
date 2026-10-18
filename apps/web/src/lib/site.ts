/** Public site configuration. Only NEXT_PUBLIC_* variables may be read here. */
export const siteConfig = {
  name: 'Kiro',
  tagline: 'Your entertainment. One place.',
  description: 'Discover, organise, and enjoy your favourite movies and shows with Kiro.',
  url: process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000',
  githubUrl: process.env.NEXT_PUBLIC_GITHUB_URL || null,
} as const;

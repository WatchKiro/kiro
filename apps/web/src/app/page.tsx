import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { Faq } from '@/features/landing/faq';
import { FeaturesSection } from '@/features/landing/features-section';
import { Hero } from '@/features/landing/hero';
import { HowItWorks } from '@/features/landing/how-it-works';
import { PlatformsSection } from '@/features/landing/platforms-section';
import { getLatestRelease } from '@/lib/releases';

/** Re-check GitHub Releases at most once an hour. */
export const revalidate = 3600;

export default async function HomePage() {
  const release = await getLatestRelease();

  return (
    <>
      <SiteHeader release={release} />
      <main>
        <Hero release={release} />
        <FeaturesSection released={release !== null} />
        <HowItWorks />
        <PlatformsSection release={release} />
        <Faq release={release} />
      </main>
      <SiteFooter release={release} />
    </>
  );
}

'use client';

import { useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GitHubIcon } from '@/components/brand/github-icon';
import { REPO_URL } from '@/config/marketing';
import { ScrollWords } from './scroll-words';
import { useAnimeEffect } from './use-anime-effect';

export function FinalCta() {
  const root = useRef<HTMLElement>(null);

  useAnimeEffect(({ animate, createScope, onScroll }) => {
    const scope = createScope({
      root,
      mediaQueries: { reduceMotion: '(prefers-reduced-motion: reduce)' },
    }).add((self) => {
      if (self?.matches.reduceMotion) return;

      // The artwork opens up toward the viewer as the band scrolls in.
      animate('[data-cta-art]', {
        scale: [0.6, 1.15],
        opacity: [0, 0.75],
        rotate: [-25, 0],
        ease: 'linear',
        autoplay: onScroll({
          target: root.current!,
          enter: 'bottom top',
          leave: 'bottom bottom',
          sync: 0.5,
        }),
      });
    });

    return () => scope.revert();
  });

  return (
    <section
      ref={root}
      className="relative overflow-hidden border-t border-mk-border bg-mk-bg text-mk-fg"
    >
      {/*
        Emerald line art on black. Light mode inverts it and rotates the hue
        180° (a plain invert would turn emerald pink), then multiplies it
        into the page so the white ground disappears.
      */}
      <Image
        data-cta-art
        src="/landing/cta-pamor.jpg"
        alt=""
        width={2200}
        height={933}
        sizes="100vw"
        className="pointer-events-none absolute inset-0 size-full object-cover opacity-75 mix-blend-multiply invert hue-rotate-180 will-change-transform dark:mix-blend-normal dark:invert-0 dark:hue-rotate-0 [mask-image:radial-gradient(70%_80%_at_50%_50%,black,transparent)]"
      />
      <div className="relative mx-auto max-w-3xl px-6 py-32 text-center sm:py-44">
        <ScrollWords
          as="h2"
          className="text-4xl font-bold tracking-tight sm:text-6xl"
        >
          Start with one product.
        </ScrollWords>
        <p className="mt-5 text-lg text-mk-fg/75">
          The rest already know your customers and your team.
        </p>
        <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
          <Button asChild size="lg" className="rounded-full">
            <Link href="/onboarding">
              Get started
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button
            asChild
            size="lg"
            variant="outline"
            className="rounded-full border-mk-fg/20 bg-mk-bg/70 text-mk-fg backdrop-blur hover:bg-mk-fg/10 hover:text-mk-fg"
          >
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              <GitHubIcon />
              View on GitHub
            </a>
          </Button>
        </div>
      </div>
    </section>
  );
}

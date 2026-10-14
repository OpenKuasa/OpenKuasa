'use client';

import { useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GitHubIcon } from '@/components/brand/github-icon';
import { PRODUCT_CARDS, REPO_URL } from '@/config/marketing';
import { BrowserFrame } from './browser-frame';
import { GridField } from './grid-field';
import { useAnimeEffect } from './use-anime-effect';

/**
 * Pinned hero. The section is several screens tall and its panel sticks, so
 * scrolling plays one sequence: the artwork settles, the headline recedes and
 * the product screenshot rises from the bottom edge and lies flat.
 * Under reduced motion it is an ordinary headline-then-screenshot layout.
 */
export function Hero() {
  const root = useRef<HTMLElement>(null);

  useAnimeEffect(({ animate, createScope, createTimeline, onScroll, splitText, stagger }) => {
    const scope = createScope({
      root,
      mediaQueries: { reduceMotion: '(prefers-reduced-motion: reduce)' },
    }).add((self) => {
      if (self?.matches.reduceMotion) return;

      // Entrance: headline letters rise in one by one.
      const { chars } = splitText('[data-hero-title]', {
        words: true,
        chars: true,
      });
      animate(chars, {
        y: ['110%', '0%'],
        opacity: [0, 1],
        rotate: [8, 0],
        duration: 900,
        ease: 'outExpo',
        delay: stagger(22),
      });
      animate('[data-hero-fade]', {
        y: [24, 0],
        opacity: [0, 1],
        duration: 900,
        ease: 'outExpo',
        delay: stagger(110, { start: 520 }),
      });

      // Scroll sequence, scrubbed by the section's scroll progress.
      createTimeline({
        defaults: { ease: 'linear' },
        autoplay: onScroll({
          target: root.current!,
          enter: 'top top',
          leave: 'bottom bottom',
          sync: 0.6,
        }),
      })
        .add('[data-hero-art]', { scale: [1.35, 1], y: ['6%', '-4%'], duration: 1000 }, 0)
        .add('[data-hero-grid]', { opacity: [0.6, 0], duration: 350 }, 0)
        .add(
          '[data-hero-copy]',
          { opacity: [1, 0], y: [0, -140], scale: [1, 0.9], duration: 420 },
          0,
        )
        .add(
          '[data-hero-shot]',
          {
            y: ['62vh', '0vh'],
            rotateX: [40, 0],
            scale: [0.74, 1],
            opacity: [1, 1],
            duration: 700,
          },
          130,
        );
    });

    return () => scope.revert();
  });

  return (
    <section
      ref={root}
      className="relative bg-mk-bg text-mk-fg motion-safe:h-[260vh]"
    >
      {/* The panel carries the page colour so the artwork has something to blend into. */}
      <div className="relative overflow-hidden bg-mk-bg motion-safe:sticky motion-safe:top-0 motion-safe:h-dvh">
        {/*
          The artwork is emerald line art on black. In light mode it is inverted
          (black becomes white) and hue-rotated 180° so the lines come back to
          emerald rather than the pink a plain invert gives, then multiplied
          into the page so its white ground disappears.
        */}
        <Image
          data-hero-art
          src="/landing/hero-pamor.jpg"
          alt=""
          width={2200}
          height={1228}
          priority
          sizes="100vw"
          className="pointer-events-none absolute inset-0 size-full object-cover opacity-70 mix-blend-multiply invert hue-rotate-180 will-change-transform dark:mix-blend-normal dark:invert-0 dark:hue-rotate-0"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_70%_at_50%_35%,color-mix(in_oklch,var(--mk-bg)_92%,transparent),color-mix(in_oklch,var(--mk-bg)_35%,transparent)_70%,transparent)]"
        />
        <div data-hero-grid className="absolute inset-x-0 top-0 opacity-60">
          <GridField
            cols={28}
            rows={12}
            className="mx-auto hidden max-w-[1600px] [mask-image:radial-gradient(70%_70%_at_50%_30%,black,transparent)] sm:grid"
          />
          <GridField
            cols={12}
            rows={14}
            className="[mask-image:radial-gradient(80%_60%_at_50%_30%,black,transparent)] sm:hidden"
          />
        </div>

        <div
          data-hero-copy
          className="relative mx-auto flex max-w-7xl flex-col items-center px-6 pt-24 text-center will-change-transform motion-safe:absolute motion-safe:inset-0 motion-safe:justify-center motion-safe:pb-[10vh] motion-safe:pt-16"
        >
          <Link
            href="/pricing"
            data-hero-fade
            className="mb-8 inline-flex items-center gap-2 rounded-full border border-mk-fg/15 bg-mk-bg/70 px-3 py-1 font-mono text-xs text-mk-fg/75 backdrop-blur transition-colors hover:bg-mk-fg/10 dark:bg-mk-bg/40"
          >
            <span className="size-1.5 rounded-full bg-mk-accent" />
            free and open source · AGPL-3.0
            <ArrowRight className="size-3.5" />
          </Link>

          <h1
            data-hero-title
            className="max-w-5xl text-5xl font-bold leading-[1.02] tracking-tight [&_span]:inline-block sm:text-7xl lg:text-8xl"
          >
            Run the whole business from one place.
          </h1>

          <p data-hero-fade className="mt-7 max-w-xl text-lg text-mk-fg/70">
            Marketing, sales, people and finance — six products on one login,
            named for the court of Melaka and powered by Taming Sari AI.
          </p>

          <p data-hero-fade className="mt-3 max-w-xl text-sm text-mk-subtle">
            Work in progress: many screens still show sample data.
          </p>

          <div data-hero-fade className="mt-9 flex flex-col gap-3 sm:flex-row">
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
              className="rounded-full border-mk-fg/20 bg-mk-bg/60 text-mk-fg backdrop-blur hover:bg-mk-fg/10 hover:text-mk-fg"
            >
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                <GitHubIcon />
                View on GitHub
              </a>
            </Button>
          </div>

          <ul
            data-hero-fade
            aria-label="The six products"
            className="mt-10 flex flex-wrap justify-center gap-x-5 gap-y-2 font-mono text-xs uppercase tracking-[0.2em] text-mk-subtle"
          >
            {PRODUCT_CARDS.map((p) => (
              <li
                key={p.key}
                className="flex items-center gap-2"
                style={{ color: `var(--mk-product-${p.key})` }}
              >
                <span aria-hidden className="size-1.5 rounded-full bg-current" />
                {p.name}
              </li>
            ))}
          </ul>
        </div>

        <div className="pointer-events-none relative mx-auto mt-16 w-full max-w-6xl px-6 pb-24 [perspective:1600px] motion-safe:absolute motion-safe:inset-0 motion-safe:mt-0 motion-safe:grid motion-safe:max-w-none motion-safe:place-items-center motion-safe:pb-0 motion-safe:pt-16">
          <div
            data-hero-shot
            className="w-full origin-top will-change-transform motion-safe:w-[min(72rem,92vw,calc((100dvh-9rem)*1.55))] motion-safe:opacity-0"
          >
            <BrowserFrame>
              <Image
                src="/landing/crm.jpg"
                alt="The Kasturi CRM deals screen: pipeline value, win rate and a deal board"
                width={1440}
                height={900}
                priority
                sizes="(min-width: 1280px) 1152px, 92vw"
                className="h-auto w-full"
              />
            </BrowserFrame>
          </div>
        </div>
      </div>
    </section>
  );
}

'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { PRODUCT_CARDS } from '@/config/marketing';
import { cn } from '@/lib/utils';
import { BrowserFrame } from './browser-frame';
import { LEGEND } from './legend';
import { useAnimeEffect } from './use-anime-effect';

const SHOT_ALT: Record<string, string> = {
  command: 'Tuah, the AI command center, ready for a question',
  reach: 'Jebat Ad Studio with campaign results',
  crm: 'Kasturi deals pipeline board',
  people: 'Lekiu payroll run',
  hire: 'Lekir candidates list',
  finance: 'Bendahara invoices',
};

/**
 * Pinned walk through the six products. The section is several screens tall;
 * its inner panel sticks while scroll position picks the active product.
 * Under reduced motion the steps still change with scroll, without transitions.
 */
export function ProductTour() {
  const root = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  const count = PRODUCT_CARDS.length;

  useAnimeEffect(({ animate, createScope, onScroll }) => {
    const scope = createScope({ root }).add(() => {
      animate('[data-tour-progress]', {
        scaleX: [0, 1],
        ease: 'linear',
        autoplay: onScroll({
          target: root.current!,
          enter: 'top top',
          leave: 'bottom bottom',
          sync: true,
          onUpdate: (observer) => {
            const index = Math.min(
              count - 1,
              Math.floor(observer.progress * count),
            );
            setActive(index);
          },
        }),
      });
    });

    return () => scope.revert();
  }, [count]);

  const current = PRODUCT_CARDS[active];

  return (
    <section
      ref={root}
      id="products"
      className="relative h-[520vh] bg-mk-bg text-mk-fg"
      style={
        {
          '--pc': `var(--mk-product-${current.key})`,
          '--frame-glow': 'color-mix(in oklch, var(--pc) 38%, transparent)',
        } as React.CSSProperties
      }
    >
      <div className="flex flex-col justify-center sticky top-0 h-dvh overflow-hidden px-6">
        <div className="mx-auto grid w-full max-w-[1500px] items-center gap-8 lg:grid-cols-[0.55fr_1.45fr] lg:gap-12">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-mk-accent">
              the court of Melaka · six products
            </p>

            {/* Product names: the active one lights up as you scroll. */}
            <ol className="mt-6 flex flex-wrap gap-x-5 gap-y-1 lg:block lg:space-y-1">
              {PRODUCT_CARDS.map((p, i) => (
                <li
                  key={p.key}
                  className={cn(
                    'text-2xl font-bold tracking-tight transition-all duration-500 motion-reduce:transition-none sm:text-3xl lg:text-5xl',
                    i === active
                      ? 'text-(--pc) lg:translate-x-3'
                      : 'text-mk-fg/20',
                  )}
                >
                  {p.name}
                </li>
              ))}
            </ol>

            <div className="mt-6 min-h-[16rem] lg:mt-10">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-mk-subtle">
                {String(active + 1).padStart(2, '0')} / {String(count).padStart(2, '0')} ·{' '}
                {current.category}
              </p>
              <p className="mt-2 text-xl font-semibold">{current.tagline}</p>
              <p className="mt-2 max-w-md text-mk-muted">{current.blurb}</p>
              <div className="mt-4 flex max-w-md gap-2.5 border-l border-(--pc)/50 pl-3 text-sm">
                <p className="text-mk-muted dark:text-mk-fg/55">
                  <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-(--pc)">
                    why {current.name}
                  </span>
                  <br />
                  {LEGEND[current.key].who}{' '}
                  <span className="text-mk-fg dark:text-mk-fg/85">
                    {LEGEND[current.key].why}
                  </span>
                </p>
              </div>
              <Link
                href={current.href}
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-(--pc) hover:underline"
              >
                Open {current.name}
                <ArrowRight className="size-4" />
              </Link>
            </div>

            <div className="mt-6 h-px w-full max-w-md bg-mk-border">
              <div
                data-tour-progress
                className="h-px origin-left scale-x-0 bg-(--pc)"
              />
            </div>
          </div>

          <BrowserFrame>
            <div className="relative aspect-[16/10]">
              {PRODUCT_CARDS.map((p, i) => (
                <Image
                  key={p.key}
                  src={`/landing/${p.key}.jpg`}
                  alt={SHOT_ALT[p.key] ?? p.name}
                  width={1440}
                  height={900}
                  sizes="(min-width: 1024px) 70vw, 100vw"
                  className={cn(
                    'absolute inset-0 size-full object-cover object-top transition-all duration-700 ease-out motion-reduce:transition-none',
                    i === active
                      ? 'scale-100 opacity-100'
                      : 'scale-[1.04] opacity-0',
                  )}
                />
              ))}
            </div>
          </BrowserFrame>
        </div>
      </div>
    </section>
  );
}

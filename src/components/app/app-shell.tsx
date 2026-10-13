'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getProduct } from '@/config/nav';
import { isSampleScreen } from '@/config/live-screens';
import { ProductRail } from './product-rail';
import { SecondaryNav } from './secondary-nav';
import { AppTopbar } from './app-topbar';
import { AssistantFab } from './assistant-fab';
import {
  ASSISTANT_FAB_CLEARANCE_REM,
  showsAssistantFab,
} from './assistant-fab-layout';
import { WipBanner } from './wip-banner';
import { TooltipProvider } from '@/components/ui/tooltip';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const key = pathname.split('/')[1] || null;
  const product = getProduct(key ?? undefined);
  const hasSecondary = !!product && product.sections.length > 0;
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [prevPathname, setPrevPathname] = useState(pathname);

  // Close the mobile drawer whenever the route changes.
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setMobileNavOpen(false);
  }

  // Menus and dialogs render outside the shell, so the active product's colour
  // scope is mirrored onto <html> for them.
  const productKey = product?.key;
  useEffect(() => {
    if (!productKey) return;
    document.documentElement.dataset.product = productKey;
    return () => {
      delete document.documentElement.dataset.product;
    };
  }, [productKey]);

  return (
    <TooltipProvider delayDuration={0}>
      <div
        data-product={productKey}
        className="flex h-dvh w-full overflow-hidden"
      >
        <ProductRail activeKey={key} />

        {/* Secondary nav — inline from md up (unless collapsed) */}
        {hasSecondary && !collapsed ? (
          <div className="hidden shrink-0 md:flex">
            <SecondaryNav
              product={product!}
              onCollapse={() => setCollapsed(true)}
            />
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <AppTopbar
            onExpand={
              hasSecondary && collapsed ? () => setCollapsed(false) : undefined
            }
            onOpenNav={
              hasSecondary ? () => setMobileNavOpen(true) : undefined
            }
          />
          {isSampleScreen(pathname) ? <WipBanner /> : null}
          <main
            // Room to scroll the last content clear of the floating button.
            style={
              showsAssistantFab(pathname)
                ? { paddingBottom: `${ASSISTANT_FAB_CLEARANCE_REM}rem` }
                : undefined
            }
            className="relative flex-1 overflow-auto bg-muted/30"
          >
            {children}
          </main>
        </div>

        {/* Secondary nav — off-canvas drawer below md */}
        {hasSecondary && mobileNavOpen ? (
          <div className="fixed inset-0 z-50 md:hidden">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setMobileNavOpen(false)}
              aria-hidden
            />
            <div className="absolute inset-y-0 left-0 shadow-xl">
              <SecondaryNav
                product={product!}
                onCollapse={() => setMobileNavOpen(false)}
              />
            </div>
          </div>
        ) : null}

        <AssistantFab />
      </div>
    </TooltipProvider>
  );
}

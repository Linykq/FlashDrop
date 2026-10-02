import { uploadPath } from '@flashdrop/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import { Price } from '../../../../components/commerce/price';
import { ProductDetails } from '../../../../components/commerce/product-details';
import { ProductGallery } from '../../../../components/commerce/product-gallery';
import {
  DropStatusLine,
  DropStatusLineSkeleton,
  LivePurchase,
  LivePurchaseSkeleton,
  ProductJsonLd,
} from '../../../../components/commerce/product-purchase';
import { Skeleton, SkeletonText } from '../../../../components/ui/skeleton';
import { TitleText } from '../../../../components/ui/title-text';
import { productHref } from '../../../../lib/routes';
import { getProduct } from '../../../../lib/server/catalog';
import { requestOrigin } from '../../../../lib/server/request';
import { summarize } from '../../../../lib/text';

/*
 * The product page (design §8.1, design-system §10.2). The product shell comes from a cached read (hours,
 * tagged `product:<id>`), and the stock and the Buy button stream into it from the uncached snapshot in
 * the same response, so the raw HTML carries the title and the current stock number. Everything here
 * waits for the request's `params` inside Suspense, so `next build` never calls api (§8.1 build rule).
 * An unknown slug gets its 404 status from proxy.ts, before this page's 200 shell is sent; the notFound()
 * calls here are the fallback for a check that couldn't reach api.
 */

export async function generateMetadata({ params }: PageProps<'/p/[slug]'>): Promise<Metadata> {
  const { slug } = await params;
  const [detail, origin] = await Promise.all([getProduct(slug), requestOrigin()]);
  if (!detail) notFound();
  const { product } = detail;
  const description = summarize(product.description);
  const photo = product.imageKeys[0];
  return {
    title: product.title,
    description,
    metadataBase: new URL(origin),
    alternates: { canonical: productHref(product.slug) },
    openGraph: {
      type: 'website',
      title: product.title,
      description,
      url: productHref(product.slug),
      images: photo ? [{ url: uploadPath(photo) }] : [],
    },
  };
}

export default function ProductPage({ params }: PageProps<'/p/[slug]'>) {
  return (
    <Suspense fallback={<ProductSkeleton />}>
      <ProductView params={params} />
    </Suspense>
  );
}

async function ProductView({ params }: Pick<PageProps<'/p/[slug]'>, 'params'>) {
  const { slug } = await params;
  const detail = await getProduct(slug);
  if (!detail) notFound();
  const { product, drop } = detail;

  return (
    <>
      <ProductLayout
        gallery={<ProductGallery title={product.title} photos={product.imageKeys.map(uploadPath)} />}
        panel={
          drop ? (
            <>
              <Suspense fallback={<DropStatusLineSkeleton />}>
                <DropStatusLine drop={drop} />
              </Suspense>
              <h1 className="mt-3 text-title-1">
                <TitleText text={product.title} />
              </h1>
              <p className="mt-3">
                <Price cents={drop.priceCents} currency={drop.currency} size="lg" />
              </p>
              <Suspense fallback={<LivePurchaseSkeleton />}>
                <LivePurchase product={product} drop={drop} />
              </Suspense>
            </>
          ) : (
            <>
              <h1 className="text-title-1">
                <TitleText text={product.title} />
              </h1>
              {/* TODO(M8): admins also get a tinted md "Create drop" link to /admin/drops?new=<productId>. */}
              <p className="mt-3 text-footnote text-label-secondary">This product isn't in a drop yet.</p>
              <ProductJsonLd product={product} offer={null} />
            </>
          )
        }
      />
      <ProductDetails product={product} />
    </>
  );
}

/**
 * Gallery and purchase panel (§10.2, §4.4). From 1069 px the gallery is at most 7 of 12 columns wide, and
 * narrower on a short window (`gallery-fit`); the panel follows the photo's actual edge at a fixed 64 px
 * gutter, up to `form` wide, and is sticky under the bar. A grid track would leave the gutter to the window's
 * height. Tablet has two equal columns; phones the full-bleed gallery directly under the bar, with the panel
 * below it inside the page margins. The bottom padding matches the details' top padding, so their hairline
 * sits in the middle of one gap rather than between two section spaces (§1.4).
 */
function ProductLayout({ gallery, panel }: { gallery: ReactNode; panel: ReactNode }) {
  return (
    <div className="pb-12 sm:page-wide sm:grid sm:grid-cols-8 sm:gap-(--grid-gap) sm:pt-8 md:flex md:items-start md:gap-16 md:pt-12 md:pb-16">
      <div className="sm:col-span-4 md:gallery-fit md:shrink-0">{gallery}</div>
      <div className="max-sm:page-wide max-sm:pt-6 sm:col-span-4 md:sticky md:top-[calc(env(safe-area-inset-top)+var(--nav-height)+--spacing(6))] md:min-w-0 md:max-w-form md:flex-1">
        {panel}
      </div>
    </div>
  );
}

/** The page's exact box while the product loads: the 4:5 photo, then the panel's lines. */
function ProductSkeleton() {
  return (
    <div aria-busy="true">
      <ProductLayout
        gallery={<Skeleton className="aspect-4/5 rounded-none sm:rounded-lg" />}
        panel={
          <div aria-hidden="true">
            <DropStatusLineSkeleton />
            <SkeletonText style="title-1" className="mt-3 w-4/5" />
            <SkeletonText style="intro" className="mt-3 w-20" />
            <LivePurchaseSkeleton />
          </div>
        }
      />
    </div>
  );
}

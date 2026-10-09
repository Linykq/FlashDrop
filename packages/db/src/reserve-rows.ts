import { z } from 'zod';
import { HotRowBusyError } from './errors';
import { type OrderWithProduct, parseOrderRows } from './orders';
import { parseRows } from './rows';

/*
 * What the reserve statements share (`transitions.ts` and the step functions of `reserve-steps.ts`). Internal:
 * the package root exports neither these nor the steps.
 */

/** query_canceled: on the api pool, its `statement_timeout`. */
export const STATEMENT_TIMEOUT = '57014';

export function hotRowBusy(dropId: string, cause: unknown): HotRowBusyError {
  return new HotRowBusyError(`stock row of drop ${dropId} busy past the statement timeout`, { cause });
}

/** The product summary the 201 answer shows, read by the same statement that inserts the order. */
const InsertedProduct = z
  .object({ product_slug: z.string(), product_title: z.string(), product_image_keys: z.array(z.string()) })
  .transform((row) => ({
    slug: row.product_slug,
    title: row.product_title,
    imageKeys: row.product_image_keys,
  }));

/** The order and product of a statement that returns both, or undefined when it returned no row. */
export function orderWithProduct(rows: readonly unknown[], statement: string): OrderWithProduct | undefined {
  const [order] = parseOrderRows(rows, statement);
  const [product] = parseRows(InsertedProduct, rows, `${statement} product`);
  if (order === undefined || product === undefined) return undefined;
  return { order, product: { id: order.productId, ...product } };
}

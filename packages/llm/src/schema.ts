import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ListingWire } from '@flashdrop/contracts';
import { z } from 'zod';

/*
 * `output_config.format` for every listing call (design §10): the SDK's Zod -> JSON Schema transform
 * without its throwing `parse`, so the code reads `stop_reason` and records usage before parsing anything.
 *
 * One correction. In @anthropic-ai/sdk 0.131.0 the transform keeps only the keywords it lists for a string
 * (`format`) and moves every other one into the description: an enum arrives as the hint `{enum: [...]}`,
 * not as a constraint. Structured outputs do enforce `enum`, and the category taxonomy, the condition and
 * the uncertainty fields are exactly what decoding should pin, so the enums are copied back from the
 * untransformed schema.
 */

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walks the strict schema and its source in step (same properties, items and variants). */
function restoreEnums(strict: unknown, source: unknown): void {
  if (Array.isArray(strict) && Array.isArray(source)) {
    for (const [i, entry] of strict.entries()) restoreEnums(entry, source[i]);
    return;
  }
  if (!isObject(strict) || !isObject(source)) return;
  if (Array.isArray(source.enum) && strict.type === 'string') {
    strict.enum = source.enum;
    // The hint the transform left in place of the constraint, now redundant.
    if (strict.description === `{enum: ${JSON.stringify(source.enum)}}`) delete strict.description;
  }
  for (const key of ['properties', '$defs']) {
    const strictMap = strict[key];
    const sourceMap = source[key];
    if (isObject(strictMap) && isObject(sourceMap)) {
      for (const name of Object.keys(strictMap)) restoreEnums(strictMap[name], sourceMap[name]);
    }
  }
  restoreEnums(strict.items, source.items);
  restoreEnums(strict.anyOf, source.anyOf);
}

function listingWireFormat(): Anthropic.Beta.Messages.BetaJSONOutputFormat {
  const { schema } = zodOutputFormat(ListingWire);
  restoreEnums(schema, z.toJSONSchema(ListingWire, { reused: 'ref' }));
  // The transform turns the root's `$schema` keyword into the hint `{$schema: "https://..."}` in the root's
  // description, which would reach the model as noise; ListingWire has no description of its own.
  if (typeof schema.description === 'string' && schema.description.startsWith('{$schema:')) {
    delete schema.description;
  }
  return { type: 'json_schema', schema };
}

export const LISTING_WIRE_FORMAT = listingWireFormat();

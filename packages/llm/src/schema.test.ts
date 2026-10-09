import { LISTING_FIELDS, PRODUCT_CATEGORIES, PRODUCT_CONDITIONS } from '@flashdrop/contracts';
import { describe, expect, it } from 'vitest';
import { LISTING_WIRE_FORMAT } from './schema';

const schema = LISTING_WIRE_FORMAT.schema;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), value);

describe('LISTING_WIRE_FORMAT', () => {
  it('is a JSON schema output format', () => {
    expect(LISTING_WIRE_FORMAT.type).toBe('json_schema');
    expect(at(schema, 'type')).toBe('object');
  });

  it('constrains the taxonomy, the condition and the uncertainty fields as enums', () => {
    expect(at(schema, 'properties', 'category')).toEqual({ type: 'string', enum: [...PRODUCT_CATEGORIES] });
    expect(at(schema, 'properties', 'condition')).toEqual({ type: 'string', enum: [...PRODUCT_CONDITIONS] });
    expect(at(schema, 'properties', 'uncertainties', 'items', 'properties', 'field')).toEqual({
      type: 'string',
      enum: [...LISTING_FIELDS],
    });
  });

  it('makes every key required and closed, with nullable attributes', () => {
    expect(at(schema, 'required')).toEqual([
      'title',
      'description',
      'highlights',
      'category',
      'attributes',
      'condition',
      'tags',
      'uncertainties',
    ]);
    expect(at(schema, 'additionalProperties')).toBe(false);
    expect(at(schema, 'properties', 'attributes', 'additionalProperties')).toBe(false);
    expect(at(schema, 'properties', 'attributes', 'properties', 'brand')).toEqual({
      type: ['string', 'null'],
    });
  });

  it('sends the model no root description: the `$schema` hint the transform leaves is noise', () => {
    expect(at(schema, 'description')).toBeUndefined();
  });

  it('carries no constraint structured outputs reject, such as string lengths', () => {
    expect(JSON.stringify(schema)).not.toMatch(/"(minLength|maxLength|pattern)"/);
  });
});
